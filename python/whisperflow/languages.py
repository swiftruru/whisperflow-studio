# Rewritten from faster-whisper-webui src/languages.py (Apache 2.0, (c) aadnk).
# Changes: converted to frozen dataclass, expanded to the full Whisper-99
# language set (the upstream file only exposed ~12 and commented out the rest),
# and added ISO-code lookup aliases.  See /NOTICES.md for license details.

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Language:
    code: str
    name: str

    def __str__(self) -> str:
        return f"{self.name} ({self.code})"


# Full set of languages supported by Whisper (v2/v3). Matches the tokenizer
# list in openai/whisper and faster-whisper.
LANGUAGES: tuple[Language, ...] = (
    Language("en", "English"),
    Language("zh", "Chinese"),
    Language("de", "German"),
    Language("es", "Spanish"),
    Language("ru", "Russian"),
    Language("ko", "Korean"),
    Language("fr", "French"),
    Language("ja", "Japanese"),
    Language("pt", "Portuguese"),
    Language("tr", "Turkish"),
    Language("pl", "Polish"),
    Language("ca", "Catalan"),
    Language("nl", "Dutch"),
    Language("ar", "Arabic"),
    Language("sv", "Swedish"),
    Language("it", "Italian"),
    Language("id", "Indonesian"),
    Language("hi", "Hindi"),
    Language("fi", "Finnish"),
    Language("vi", "Vietnamese"),
    Language("he", "Hebrew"),
    Language("uk", "Ukrainian"),
    Language("el", "Greek"),
    Language("ms", "Malay"),
    Language("cs", "Czech"),
    Language("ro", "Romanian"),
    Language("da", "Danish"),
    Language("hu", "Hungarian"),
    Language("ta", "Tamil"),
    Language("no", "Norwegian"),
    Language("th", "Thai"),
    Language("ur", "Urdu"),
    Language("hr", "Croatian"),
    Language("bg", "Bulgarian"),
    Language("lt", "Lithuanian"),
    Language("la", "Latin"),
    Language("mi", "Maori"),
    Language("ml", "Malayalam"),
    Language("cy", "Welsh"),
    Language("sk", "Slovak"),
    Language("te", "Telugu"),
    Language("fa", "Persian"),
    Language("lv", "Latvian"),
    Language("bn", "Bengali"),
    Language("sr", "Serbian"),
    Language("az", "Azerbaijani"),
    Language("sl", "Slovenian"),
    Language("kn", "Kannada"),
    Language("et", "Estonian"),
    Language("mk", "Macedonian"),
    Language("br", "Breton"),
    Language("eu", "Basque"),
    Language("is", "Icelandic"),
    Language("hy", "Armenian"),
    Language("ne", "Nepali"),
    Language("mn", "Mongolian"),
    Language("bs", "Bosnian"),
    Language("kk", "Kazakh"),
    Language("sq", "Albanian"),
    Language("sw", "Swahili"),
    Language("gl", "Galician"),
    Language("mr", "Marathi"),
    Language("pa", "Punjabi"),
    Language("si", "Sinhala"),
    Language("km", "Khmer"),
    Language("sn", "Shona"),
    Language("yo", "Yoruba"),
    Language("so", "Somali"),
    Language("af", "Afrikaans"),
    Language("oc", "Occitan"),
    Language("ka", "Georgian"),
    Language("be", "Belarusian"),
    Language("tg", "Tajik"),
    Language("sd", "Sindhi"),
    Language("gu", "Gujarati"),
    Language("am", "Amharic"),
    Language("yi", "Yiddish"),
    Language("lo", "Lao"),
    Language("uz", "Uzbek"),
    Language("fo", "Faroese"),
    Language("ht", "Haitian Creole"),
    Language("ps", "Pashto"),
    Language("tk", "Turkmen"),
    Language("nn", "Nynorsk"),
    Language("mt", "Maltese"),
    Language("sa", "Sanskrit"),
    Language("lb", "Luxembourgish"),
    Language("my", "Myanmar"),
    Language("bo", "Tibetan"),
    Language("tl", "Tagalog"),
    Language("mg", "Malagasy"),
    Language("as", "Assamese"),
    Language("tt", "Tatar"),
    Language("haw", "Hawaiian"),
    Language("ln", "Lingala"),
    Language("ha", "Hausa"),
    Language("ba", "Bashkir"),
    Language("jw", "Javanese"),
    Language("su", "Sundanese"),
    Language("yue", "Cantonese"),
)


# Alternate English names that Whisper's tokenizer accepts as aliases.
_NAME_ALIASES: dict[str, str] = {
    "burmese": "my",
    "valencian": "ca",
    "flemish": "nl",
    "haitian": "ht",
    "letzeburgesch": "lb",
    "pushto": "ps",
    "panjabi": "pa",
    "moldavian": "ro",
    "moldovan": "ro",
    "sinhalese": "si",
    "castilian": "es",
    "mandarin": "zh",
}


_BY_CODE: dict[str, Language] = {lang.code: lang for lang in LANGUAGES}
_BY_NAME: dict[str, Language] = {lang.name.lower(): lang for lang in LANGUAGES}


def get_language_by_code(code: str) -> Optional[Language]:
    """Look up a language by ISO code (e.g. ``"en"``). Returns ``None`` if unknown."""
    if not code:
        return None
    return _BY_CODE.get(code.lower())


def get_language_by_name(name: str) -> Optional[Language]:
    """Look up a language by English name (e.g. ``"Chinese"``). Case-insensitive.

    Accepts the aliases Whisper's tokenizer recognises (e.g. ``"Mandarin"`` → zh).
    Returns ``None`` if unknown.
    """
    if not name:
        return None
    key = name.strip().lower()
    lang = _BY_NAME.get(key)
    if lang is not None:
        return lang
    alias_code = _NAME_ALIASES.get(key)
    if alias_code is not None:
        return _BY_CODE.get(alias_code)
    return None


def resolve_language_code(value: Optional[str]) -> Optional[str]:
    """Accept either a name or a code and return a canonical ISO code.

    Returns ``None`` for ``None``/empty input (meaning auto-detect).
    Raises ``ValueError`` if the value is non-empty but unrecognised.
    """
    if value is None or value == "":
        return None
    # Try code first, then name.
    by_code = get_language_by_code(value)
    if by_code is not None:
        return by_code.code
    by_name = get_language_by_name(value)
    if by_name is not None:
        return by_name.code
    raise ValueError(f"unknown language: {value!r}")


def get_language_names() -> list[str]:
    """Return the full list of supported language display names (UI dropdown)."""
    return [lang.name for lang in LANGUAGES]
