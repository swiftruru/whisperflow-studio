"""
Bridge script for Electron: runs the CLI transcription without terminal animations.
Replaces os.system() with subprocess.Popen so stdout streams to Electron in real-time.
"""

import os
import sys
import importlib.util
import subprocess
import json
from datetime import datetime

# python/ lives next to bridge/ inside whisperflow-studio/.
# Using __file__ makes this path correct regardless of cwd or where the app is moved.
SCRIPT_DIR   = os.path.dirname(os.path.realpath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', 'python'))

_spec = importlib.util.spec_from_file_location(
    'whisper_cli_run',
    os.path.join(PROJECT_ROOT, 'faster-whisper-webui-cli.run.py'),
)
_mod = importlib.util.module_from_spec(_spec)
sys.path.insert(0, PROJECT_ROOT)   # for common.colors etc.
_spec.loader.exec_module(_mod)

WhisperFasterScript = _mod.WhisperFasterScript


class HeadlessWhisperScript(WhisperFasterScript):
    """Subclass that skips terminal animations and uses Popen for streaming output."""

    event_prefix = '[WhisperFlowEvent]'

    def _event_timestamp(self):
        return datetime.utcnow().isoformat(timespec='seconds') + 'Z'

    def _elapsed_seconds(self, start_time):
        if not start_time:
            return None
        return max(0, int((datetime.now() - start_time).total_seconds()))

    def emit_event(
        self,
        event_type,
        stage=None,
        message='',
        progress=None,
        elapsed_seconds=None,
        eta_seconds=None,
        extra=None,
    ):
        wc = self.whisper_config
        payload = {
            'type': event_type,
            'stage': stage or '',
            'message': message or '',
            'progress': progress,
            'elapsedSeconds': elapsed_seconds,
            'etaSeconds': eta_seconds,
            'filePath': os.path.join(wc.media_file_path or '', wc.media_file_name or ''),
            'fileName': wc.media_file_name or '',
            'timestamp': self._event_timestamp(),
            'source': 'bridge',
        }

        if extra:
            payload['meta'] = extra

        print(f'{self.event_prefix} {json.dumps(payload, ensure_ascii=False)}')
        sys.stdout.flush()

    def build_and_execute_command(self):
        wc = self.whisper_config
        os.chdir(wc.whisper_faster_tool_path)

        command_start = datetime.now()

        self.emit_event(
            'stage',
            stage='loading-model',
            message='Preparing CLI command',
            progress=20,
            elapsed_seconds=self._elapsed_seconds(command_start),
        )

        print(f'[WhisperFlow] Whisper tool: "{wc.whisper_faster_tool_path}"')
        print(f'[WhisperFlow] Target file:  "{wc.media_file_name}"')
        print(f'[WhisperFlow] Model: {wc.model}  Language: {wc.language}')
        sys.stdout.flush()

        start_time = datetime.now()
        print(f'[WhisperFlow] Started at: {start_time.strftime("%Y-%m-%d %H:%M:%S")}\n')
        sys.stdout.flush()

        # Use the absolute poetry path injected by the Electron runner so the
        # packaged app works even when ~/.local/bin is not in the GUI PATH.
        poetry_bin = os.environ.get('WHISPERFLOW_POETRY_PATH') or 'poetry'

        # Build args as a proper list so the OS passes them verbatim —
        # no shell quoting needed, handles any special chars in paths/prompts.
        cmd = [
            poetry_bin, 'run', 'python', 'cli.py',
            '--whisper_implementation', wc.whisper_implementation,
            '--model',                   wc.model,
            '--fp16',                    wc.fp16_enabled,
            '--auto_parallel',           wc.auto_parallel_enabled,
            '--vad',                     wc.vad_argument,
        ]

        if wc.vad_max_merge_size not in (None, ''):
            cmd.extend(['--vad_max_merge_size', str(wc.vad_max_merge_size)])

        cmd.extend([
            '--language',                wc.language,
            '--initial_prompt',          wc.initial_prompt or '',
            '--vad_initial_prompt_mode', wc.vad_initial_prompt_mode,
            '--output_dir',              f'{wc.media_file_path}/',
            f'{wc.media_file_path}/{wc.media_file_name}',
        ])

        proc = subprocess.Popen(
            cmd,
            stdout=sys.stdout,
            stderr=sys.stderr,
            cwd=wc.whisper_faster_tool_path,
        )

        self.emit_event(
            'stage',
            stage='transcribing',
            message='CLI process started',
            progress=45,
            elapsed_seconds=self._elapsed_seconds(start_time),
        )

        return_code = proc.wait()

        end_time = datetime.now()
        formatted = self.format_duration(end_time - start_time)
        print(f'\n[WhisperFlow] Finished at: {end_time.strftime("%Y-%m-%d %H:%M:%S")}')
        print(f'[WhisperFlow] Duration: {formatted}')
        sys.stdout.flush()

        if return_code != 0:
            self.emit_event(
                'error',
                stage='failed',
                message=f'CLI process exited with code {return_code}',
                progress=None,
                elapsed_seconds=self._elapsed_seconds(start_time),
                extra={'returnCode': return_code},
            )
            return

        self.emit_event(
            'stage',
            stage='writing-subtitle',
            message='CLI process finished, verifying subtitle output',
            progress=90,
            elapsed_seconds=self._elapsed_seconds(start_time),
        )

        if self.has_subtitle(self.whisper_config.media_file_name, self.whisper_config.media_file_path):
            print(f'[WhisperFlow] Subtitles generated: "{self.whisper_config.media_file_name}"')
            self.emit_event(
                'completed',
                stage='completed',
                message='Subtitle files generated',
                progress=100,
                elapsed_seconds=self._elapsed_seconds(start_time),
            )
        else:
            print('[WhisperFlow] Warning: subtitle file not found after transcription.')
            self.emit_event(
                'warning',
                stage='writing-subtitle',
                message='CLI finished but subtitle file was not found',
                progress=95,
                elapsed_seconds=self._elapsed_seconds(start_time),
            )
        sys.stdout.flush()

    def check_directory_and_file(self):
        """Override to remove time.sleep() calls that block streaming."""
        import os as _os
        wc = self.whisper_config

        self.emit_event(
            'stage',
            stage='preparing',
            message='Validating configuration and input file',
            progress=10,
        )

        if not _os.path.isdir(wc.whisper_faster_tool_path):
            self.emit_event(
                'error',
                stage='failed',
                message=f'Whisper tool directory does not exist: {wc.whisper_faster_tool_path}',
                extra={'reason': 'invalid_tool_path'},
            )
            print(f'[WhisperFlow] Error: Directory "{wc.whisper_faster_tool_path}" does not exist.')
            sys.exit(1)

        print(f'[WhisperFlow] Reading config.json ...')
        sys.stdout.flush()

        if not wc.media_file_name:
            self.emit_event(
                'warning',
                stage='completed',
                message='No media file specified for recognition',
                progress=100,
            )
            print('[WhisperFlow] No media file specified for recognition.')
            sys.exit(0)

        media_file = _os.path.join(wc.media_file_path, wc.media_file_name)
        if not _os.path.exists(media_file):
            self.emit_event(
                'error',
                stage='failed',
                message=f'Target file not found: {wc.media_file_name}',
                extra={'reason': 'missing_media_file'},
            )
            print(f'[WhisperFlow] Error: Target file "{wc.media_file_name}" not found.')
            sys.exit(1)

        if self.has_subtitle(wc.media_file_name, wc.media_file_path):
            self.emit_event(
                'warning',
                stage='completed',
                message=f'File already has subtitles: {wc.media_file_name}',
                progress=100,
            )
            print(f'[WhisperFlow] File "{wc.media_file_name}" already has subtitles. Skipping.')
            sys.exit(1)

        print(f'[WhisperFlow] File "{wc.media_file_name}" has no subtitles — starting transcription.')
        sys.stdout.flush()


def main():
    script = HeadlessWhisperScript(PROJECT_ROOT)
    script.check_directory_and_file()
    script.build_and_execute_command()


if __name__ == '__main__':
    main()
