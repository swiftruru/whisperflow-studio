# import fnmatch
import json
import os
import sys
from datetime import datetime
import time
from common.colors import Colors
# from subtitle_utils import has_subtitle


class WhisperFasterConfigData:
    """Class to hold configuration data for the Whisper faster tool."""

    def __init__(self):
        self.whisper_faster_tool_path = None
        self.whisper_implementation = None
        self.python_executor = None
        self.model = None
        self.fp16_enabled = None
        self.auto_parallel_enabled = None
        self.vad_argument = None
        self.language = None
        self.initial_prompt = None
        self.vad_initial_prompt_mode = None
        self.media_file_path = None  # Added new attribute
        self.media_file_name = None


class WhisperFasterScript:
    """Class to manage the Whisper faster script operations."""

    def __init__(self, script_path):
        self.script_path = script_path
        self.config_directory = os.path.join(self.script_path, "config")
        self.config_file_name = os.path.join(self.config_directory, "config.json")
        self.config_section = "SETTING"
        self.whisper_tool_script = "cli.py"
        self.whisper_config = WhisperFasterConfigData()
        self.config_file_path = self.get_config_file_path()  # Get the full path to the config.ini file
        self.read_config()

    def get_config_file_path(self):
        """Get the full path to the config.ini file."""
        return os.path.join(self.script_path, self.config_file_name)

    def read_config(self):
        """Reads configuration from the config.json file and sets properties in WhisperFasterConfigData."""
        with open(self.config_file_path, 'r', encoding='utf-8') as f:
            config = json.load(f)

        section = config.get(self.config_section, {})
        for key, value in section.items():
            if hasattr(self.whisper_config, key):
                setattr(self.whisper_config, key, value)

        if self.whisper_config.python_executor == 'poetry':
            self.whisper_config.python_executor = 'poetry run python'

    @staticmethod
    def has_subtitle(file_name, dir_path):
        """
        Checks if a file has a corresponding subtitle file in the same directory.

        Args:
            file_name (str): The name of the media file
            dir_path (str): The directory path where the media file is located

        Returns:
            bool: True if subtitle exists, False otherwise
        """
        # print("\nDEBUG: Starting subtitle check")
        # print(f"DEBUG: Checking for subtitles of file: {file_name}")
        # print(f"DEBUG: In directory: {dir_path}")

        try:
            files_in_dir = os.listdir(dir_path)
            # print(f"DEBUG: Files in directory: {files_in_dir}")
        except OSError:
            print(f"Error: Cannot access directory {dir_path}")
            return False

        # Convert filenames to lowercase for case-insensitive comparison
        file_name_lower = file_name.lower()
        files_in_dir_lower = [f.lower() for f in files_in_dir]

        # print(f"DEBUG: Converted filename: {file_name_lower}")
        # print(f"DEBUG: Files in dir (lowercase): {files_in_dir_lower}")

        # Check for the full filename with "-subs" suffix
        subtitle_patterns = [
            f"{file_name_lower}-subs.srt",
            f"{file_name_lower}-subs.vtt",
            f"{file_name_lower}-subs.ass",
            f"{file_name_lower}-subs.ssa"
        ]

        # print(f"DEBUG: Looking for these patterns: {subtitle_patterns}")

        # Check if any of the subtitle patterns exist in the directory
        for pattern in subtitle_patterns:
            # print(f"DEBUG: Checking pattern: {pattern}")
            if pattern in files_in_dir_lower:
                # print(f"DEBUG: Found matching subtitle: {pattern}")
                return True

        # print("DEBUG: No matching subtitles found")
        return False

    def check_directory_and_file(self):
        """Checks if the file specified in the configuration exists in the directory or subdirectories."""
        if not os.path.isdir(self.whisper_config.whisper_faster_tool_path):
            print(f'Error: Directory "{self.whisper_config.whisper_faster_tool_path}" does not exist.')
            sys.exit(1)

        print(f'Reading {Colors.GREEN("config.json")} ...')
        time.sleep(0.8)

        if not self.whisper_config.media_file_name:
            print(f'\n{Colors.LIGHT_RED("No media files specified for recognition.")}\n')
            sys.exit(0)

        media_file = os.path.join(self.whisper_config.media_file_path, self.whisper_config.media_file_name)

        if not os.path.exists(media_file):
            print('Error: Target media file '
                  f'"{self.whisper_config.media_file_name}" not found in directory or subdirectories.')
            sys.exit(1)

        # Check if the media file already has subtitles in the same directory
        # media_file_basename = os.path.splitext(self.whisper_config.media_file_name)[0]

        # if self.has_subtitle(media_file_basename, self.whisper_config.media_file_path):
        if self.has_subtitle(self.whisper_config.media_file_name, self.whisper_config.media_file_path):
            print(
                f'{Colors.LIGHT_RED("Oops ... The media file")} "{Colors.GREEN(self.whisper_config.media_file_name)}"'
                f' {Colors.LIGHT_RED("already has corresponding subtitle files.")}')
            sys.exit(1)

        # 如果程序能执行到这里，说明没有发现字幕文件
        print(
            f'The media file "{Colors.YELLOW(self.whisper_config.media_file_name)}" does not have subtitles and will be processed.')
        print(f'Located at the path: "{Colors.YELLOW(self.whisper_config.media_file_path)}"\n')
        time.sleep(1)

    def animate_command_output(self, readable_whisper_command):
        """Animates the output of the command."""

        # Print part of the first line character by character
        partial_first_line = (f"{Colors.YELLOW(self.whisper_config.python_executor)} "
                              f"{Colors.CYAN(self.whisper_tool_script)}"
                              f" --whisper_implementation ")
        for char in partial_first_line:
            sys.stdout.write(char)
            sys.stdout.flush()
            time.sleep(0.08)

        time.sleep(0.3)
        # Print the remaining part of the first line directly
        remaining_first_line = f"{Colors.BLUE(self.whisper_config.whisper_implementation)}✨✨\n"
        print(remaining_first_line, end='')
        time.sleep(1)

        # Print the remaining lines with a delay, except for the last two lines.
        for line in readable_whisper_command.split('\n')[2:-2]:
            print(line)
            time.sleep(0.8)  # Delay between each line

        # Print the last line character by characterThe first parameter of output_dir,
        # the location for placing audio and video subtitle files.
        # for line in readable_whisper_command.split('\n')[-2:-1]:
        #     print(f'{Colors.GREEN(line)}')
        #     time.sleep(0.8)  # Delay between each line
        print(f'"{Colors.GREEN(self.whisper_config.media_file_path)}/\n', end='')

        # Special handling for the last line to print the directory directly and filename character by character
        print(f'"{Colors.GREEN(self.whisper_config.media_file_path)}/', end='')
        time.sleep(1.2)
        for char in Colors.BLUE(self.whisper_config.media_file_name):
            sys.stdout.write(char)
            sys.stdout.flush()
            time.sleep(0.05)

        print('"\n')  # Close the quotes and print a new line after command print

    def build_readable_whisper_command(self):
        """Builds a readable whisper command with proper spacing."""
        command_parts = [
            f"{self.whisper_config.python_executor} {self.whisper_tool_script}",
            f"--whisper_implementation {self.whisper_config.whisper_implementation}",
            f"--model {self.whisper_config.model}",
            f"--fp16 {self.whisper_config.fp16_enabled}",
            f"--auto_parallel {self.whisper_config.auto_parallel_enabled}",
            f"--vad {self.whisper_config.vad_argument}",
            f'--language {self.whisper_config.language}',
            f'--initial_prompt "{self.whisper_config.initial_prompt}"',
            f"--vad_initial_prompt_mode {self.whisper_config.vad_initial_prompt_mode}",
            f'--output_dir \n"{self.whisper_config.media_file_path}/"',
            f'"{self.whisper_config.media_file_path}/{self.whisper_config.media_file_name}"'
        ]
        return " \n".join(command_parts)

    @staticmethod
    def build_clean_command(readable_command):
        """Builds a clean command string without newlines and tabs."""
        return readable_command.replace("\n", " ").replace("\t", "")

    def build_and_execute_command(self):
        """Builds and executes the command for the Whisper faster tool."""
        os.chdir(self.whisper_config.whisper_faster_tool_path)

        readable_whisper_command = self.build_readable_whisper_command()
        clean_command = self.build_clean_command(readable_whisper_command)

        print(f'Whisper tool directory: "{Colors.CYAN(self.whisper_config.whisper_faster_tool_path)}"\n')
        time.sleep(1.5)

        separator = Colors.LIGHT_RED('-*'*33 + '-')  # Separator for the command output
        print(f'\n{separator}\n')
        self.animate_command_output(readable_whisper_command)
        print(f'\n{separator}\n')

        time.sleep(1.5)
        # print(clean_command)
        self.execute_command(clean_command)

    def execute_command(self, command):
        """Executes the given command and measures execution time."""
        start_time = datetime.now()
        print(f"Command execution started at: {Colors.MAGENTA(start_time.strftime('%Y-%m-%d %H:%M:%S'))}\n\n")

        time.sleep(0.5)
        os.system(command.replace("\n", " "))

        end_time = datetime.now()
        duration = end_time - start_time
        formatted_duration = self.format_duration(duration)
        print(f"\nCommand execution finished at: {Colors.MAGENTA(end_time.strftime('%Y-%m-%d %H:%M:%S'))}")
        print(f"Total execution time: {Colors.MAGENTA(formatted_duration)}\n")

        if self.has_subtitle(self.whisper_config.media_file_name, self.whisper_config.media_file_path):
            print(f'Successfully generated subtitles for the video file: "'
                  f'{Colors.GREEN(self.whisper_config.media_file_name)}"\n'
                  f'Located at the path: "{Colors.GREEN(self.whisper_config.media_file_path)}"\n')

    @staticmethod
    def format_duration(duration):
        """Formats a time duration into a human-readable format."""
        total_seconds = round(duration.total_seconds())
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        return f"{hours} hours {minutes:02d} minutes {seconds:02d} seconds"


def main():
    """Main function to instantiate and run the WhisperFasterScript."""
    script = WhisperFasterScript(os.path.dirname(os.path.realpath(__file__)))
    script.check_directory_and_file()
    script.build_and_execute_command()


if __name__ == "__main__":
    main()
