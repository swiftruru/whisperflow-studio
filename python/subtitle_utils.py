import os
from config_metadata import get_subtitle_extensions


def prepare_file_list(search_target):
    """Prepares a list of files from the given search target without using 'else'."""
    if isinstance(search_target, str) and os.path.isdir(search_target):
        return os.listdir(search_target)
    if isinstance(search_target, list):
        return search_target
    raise ValueError("search_target must be a directory path or a list of file names")


def has_subtitle(base_name, search_target):
    """
    Checks if a file has a corresponding subtitle file, allowing for additional characters between the base name and the extension.
    - base_name: The base name of the file without extension.
    - search_target: Can be either a directory path (str) or a list of file names (list).
    """
    subtitle_extensions = get_subtitle_extensions()
    files = prepare_file_list(search_target)
    base_name_no_ext = os.path.splitext(base_name.lower())[0]  # Remove the extension from the base name

    # print("Debugging Information:")
    # print("Base Name Lower:", base_name_no_ext)
    # print("Files in Directory:", files)

    # Iterate through each file in the directory and check for subtitles
    for file in files:
        file_lower = file.lower()
        if file_lower.startswith(base_name_no_ext) and any(file_lower.endswith(ext) for ext in subtitle_extensions):
            # print("Subtitle found:", file)
            return True

    # print("No subtitle found for:", base_name)
    return False
