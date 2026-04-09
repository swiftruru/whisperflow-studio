import json
import os


def load_config_metadata():
    metadata_path = os.path.join(os.path.dirname(__file__), "config", "config.metadata.json")

    try:
        with open(metadata_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"settingsUi": {}, "media": {}}


def _normalize_extensions(values):
    return [value.lower() for value in values if isinstance(value, str)]


def get_supported_media_extensions():
    metadata = load_config_metadata()
    return _normalize_extensions(metadata.get("media", {}).get("supportedMediaExtensions", []))


def get_subtitle_extensions():
    metadata = load_config_metadata()
    return _normalize_extensions(metadata.get("media", {}).get("subtitleExtensions", []))
