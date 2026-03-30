"""
Bridge script for Electron: runs the CLI transcription without terminal animations.
Replaces os.system() with subprocess.Popen so stdout streams to Electron in real-time.
"""

import os
import sys
import importlib.util
import subprocess
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

    def build_and_execute_command(self):
        wc = self.whisper_config
        os.chdir(wc.whisper_faster_tool_path)

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
            '--language',                wc.language,
            '--initial_prompt',          wc.initial_prompt or '',
            '--vad_initial_prompt_mode', wc.vad_initial_prompt_mode,
            '--output_dir',              f'{wc.media_file_path}/',
            f'{wc.media_file_path}/{wc.media_file_name}',
        ]

        proc = subprocess.Popen(
            cmd,
            stdout=sys.stdout,
            stderr=sys.stderr,
            cwd=wc.whisper_faster_tool_path,
        )
        proc.wait()

        end_time = datetime.now()
        formatted = self.format_duration(end_time - start_time)
        print(f'\n[WhisperFlow] Finished at: {end_time.strftime("%Y-%m-%d %H:%M:%S")}')
        print(f'[WhisperFlow] Duration: {formatted}')
        sys.stdout.flush()

        if self.has_subtitle(self.whisper_config.media_file_name, self.whisper_config.media_file_path):
            print(f'[WhisperFlow] Subtitles generated: "{self.whisper_config.media_file_name}"')
        else:
            print('[WhisperFlow] Warning: subtitle file not found after transcription.')
        sys.stdout.flush()

    def check_directory_and_file(self):
        """Override to remove time.sleep() calls that block streaming."""
        import os as _os
        wc = self.whisper_config

        if not _os.path.isdir(wc.whisper_faster_tool_path):
            print(f'[WhisperFlow] Error: Directory "{wc.whisper_faster_tool_path}" does not exist.')
            sys.exit(1)

        print(f'[WhisperFlow] Reading config.ini ...')
        sys.stdout.flush()

        if not wc.media_file_name:
            print('[WhisperFlow] No media file specified for recognition.')
            sys.exit(0)

        media_file = _os.path.join(wc.media_file_path, wc.media_file_name)
        if not _os.path.exists(media_file):
            print(f'[WhisperFlow] Error: Target file "{wc.media_file_name}" not found.')
            sys.exit(1)

        if self.has_subtitle(wc.media_file_name, wc.media_file_path):
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
