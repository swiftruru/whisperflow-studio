import argparse
import json
import os
import re
import sys
from common.colors import Colors
from subtitle_utils import has_subtitle


class ConfigSettingScript:
    """
    Class to manage configuration settings and operations for media files without subtitles.
    """

    def __init__(self, root_path):
        self.media_path_key = 'media_file_path'
        self.media_name_key = 'media_file_name'
        self.media_root_path_key = 'media_root_path'
        self.media_root_path = root_path.strip('"')
        self.config_directory = os.path.join(os.path.dirname(__file__), "config")
        self.config_file_name = os.path.join(self.config_directory, "config.json")
        self.video_extensions = [".mp4", ".mov", ".mkv", ".avi", ".ts", ".mjpeg", ".mpeg", ".f4v", ".flv", ".m2t",
                                 ".m2ts", ".m2v", ".3gp", ".3g2", ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".m4v",
                                 ".aiff"]

    @staticmethod
    def natural_sort_key(s):
        """Provides a natural sort key."""
        return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]

    def find_missing_subtitles(self):
        """Finds the first video file without subtitles in the specified media path."""
        print(f'\nScanning the target directory for media files without subtitles:\n')
        print(Colors.GREEN(self.media_root_path))

        missing_videos = []
        total_directories = total_files = 0
        missing_video_directory = ""

        for root, dirs, files in os.walk(self.media_root_path):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            total_directories += len(dirs)
            total_files += len(files)

            for video_file in files:
                file_ext = os.path.splitext(video_file)[1].lower()
                if (file_ext in self.video_extensions and
                        not has_subtitle(video_file.lower(), [f.lower() for f in files])):
                    missing_videos.append((video_file, root))  # Store both the file name and its directory

        if missing_videos:
            missing_videos.sort(key=lambda x: self.natural_sort_key(x[0]))  # Sort based on file names
            first_missing_video, missing_video_directory = missing_videos[0]  # Get the first item from the sorted list
            return [first_missing_video], total_directories, total_files, missing_video_directory

        return [], total_directories, total_files, missing_video_directory

    def update_config(self, missing_subtitle_name="", missing_video_directory=""):
        """Updates the configuration file with the missing subtitle name and video directory."""
        with open(self.config_file_name, 'r', encoding='utf-8') as f:
            config = json.load(f)

        config.setdefault('SETTING', {})
        config['SETTING'][self.media_root_path_key] = self.media_root_path
        config['SETTING'][self.media_path_key] = missing_video_directory
        config['SETTING'][self.media_name_key] = missing_subtitle_name

        with open(self.config_file_name, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)

    @staticmethod
    def show_summary(total_directories, total_files):
        """Displays the total number of directories and files scanned."""
        print(f"\n"
              f"Total directories scanned: {Colors.MAGENTA(total_directories)}, "
              f"Total files scanned: {Colors.MAGENTA(total_files)}\n")

    def run(self):
        """Executes the main process of finding and updating the missing subtitles."""
        missing_videos, total_directories, total_files, missing_video_directory = self.find_missing_subtitles()

        if missing_videos:
            self.update_config(missing_videos[0], missing_video_directory)
            print(f'\nUpdated {Colors.YELLOW(self.media_name_key)} in config.json: "{Colors.YELLOW(missing_videos[0])}"')
            print(f'Updated {Colors.YELLOW(self.media_path_key)} '
                  f'in config.json: "{Colors.YELLOW(missing_video_directory)}"')
            self.show_summary(total_directories, total_files)
            return

        print("\nCongratulations! All videos have corresponding subtitle files.")
        self.update_config()
        self.show_summary(total_directories, total_files)


class CustomArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        sys.stderr.write(Colors.RED(f"Error: {message}\n\n"))
        self.print_help()
        sys.exit(2)


def parse_arguments():
    """Parse command line arguments."""
    parser = CustomArgumentParser(description='Configuration settings management for media files.')
    parser.add_argument('--root_path',
                        help='Root path of the media files. If not provided, it will be read from config.json.')
    return parser.parse_args()


def read_config_setting(config_file_name, section, setting, default=""):
    """Reads a specific setting from the configuration file."""
    try:
        with open(config_file_name, 'r', encoding='utf-8') as f:
            config = json.load(f)
        return config.get(section, {}).get(setting, default)
    except (OSError, json.JSONDecodeError):
        return default


def get_media_root_path(config_file_name):
    """Get the media root path based on configuration and user input."""
    media_root_path_configured = read_config_setting(config_file_name, "SETTING", "media_root_path")

    prompt = 'Please enter the media folder path to scan [Press Enter to use the script\'s location]\n-> '
    if media_root_path_configured:
        print(f"Detected 'media_root_path' setting:\n{media_root_path_configured}\n")
        prompt = 'Please enter the media folder path to scan [Press Enter to use the above location]\n-> '

    sys.stdout.write(prompt)
    sys.stdout.flush()
    input_value = input()
    return input_value or media_root_path_configured or os.path.dirname(__file__)


def main():
    args = parse_arguments()

    config_directory = os.path.join(os.path.dirname(__file__), "config")
    config_file_name = os.path.join(config_directory, "config.json")

    # Use the root path from the argument if provided, otherwise, get it from user input or config file.
    root_path = args.root_path if args.root_path else get_media_root_path(config_file_name)

    if not root_path or not os.path.isdir(root_path):
        print(Colors.RED("Error: A valid root path is not provided."))
        sys.exit(1)

    script = ConfigSettingScript(root_path)
    script.run()


if __name__ == "__main__":
    main()
