class Color:
    """
    Represents a foreground color. Can be called with text to apply the color.
    """
    RESET = '\033[0m'

    def __init__(self, color_code):
        self.color_code = color_code

    def __call__(self, text, background=None):
        bg_code = background.color_code if background else ''
        return f"{self.color_code}{bg_code}{text}{Color.RESET}"


class BG_Color:
    """
    Represents a background color.
    """

    def __init__(self, color_code):
        self.color_code = color_code


# Foreground color definitions
class Colors:
    BLACK = Color('\033[30m')
    RED = Color('\033[31m')
    LIGHT_RED = Color('\033[91m')  # light red text, similar to pink
    GREEN = Color('\033[32m')
    YELLOW = Color('\033[33m')
    BLUE = Color('\033[34m')
    MAGENTA = Color('\033[35m')
    CYAN = Color('\033[36m')
    WHITE = Color('\033[37m')
    RESET = Color('\033[0m')


# Background color definitions
class BgColors:
    BLACK = BG_Color('\033[40m')
    RED = BG_Color('\033[41m')
    LIGHT_RED = BG_Color('\033[91m')  # light red text, similar to pink
    GREEN = BG_Color('\033[42m')
    YELLOW = BG_Color('\033[43m')
    BLUE = BG_Color('\033[44m')
    MAGENTA = BG_Color('\033[45m')
    CYAN = BG_Color('\033[46m')
    WHITE = BG_Color('\033[47m')

# Example usage
# print(Colors.RED("This is red text"))
# print(Colors.BLUE("This is blue text", BgColors.YELLOW))
