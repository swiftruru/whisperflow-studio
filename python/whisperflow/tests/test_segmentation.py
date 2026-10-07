"""Unit tests for subtitles/segmentation.py (stdlib only, safe to run anywhere)."""

from __future__ import annotations

import random
import re
from pathlib import Path

import pytest

from whisperflow.subtitles.segmentation import (
    CJK_PROFILE,
    LATIN_PROFILE,
    SegmentationOptions,
    SegmentationStats,
    apply_to_result,
    build_runs,
    char_columns,
    interpolate_words,
    profile_for,
    resegment,
    resolve_limits,
    text_columns,
    wrap_text,
)
from whisperflow.subtitles.segmentation import _make_token


# The real sentence from docs/specs/subtitle-segmentation.md section 3.4:
# 36:18.848 -> 36:39.548 of the 2026-10-07 recording, 303 characters over
# 20.7 seconds (14.64 characters per second).
REAL_SENTENCE = (
    "If we have a more accurate estimation of a main effect, it can reduce, "
    "it can support the decision making in the future and can reduce the "
    "logistic cost. So we argue that this, it is cheaper than the partial "
    "dependence plot. And it is much more cheaper than if you do a real "
    "experiment in the real life."
)
REAL_START = 2178.848
REAL_END = 2199.548


def words(
    text: str,
    *,
    start: float = 0.0,
    end: float | None = None,
    speaker: int | None = None,
    cjk: bool = False,
) -> list[dict]:
    """Build a word list from a string, spread evenly across its span.

    Mirrors faster-whisper's convention exactly: a Latin word carries its
    own leading space, a CJK word carries none.  That is what lets
    ``"".join(...)`` round-trip both.
    """
    tokens = list(text) if cjk else re.findall(r"\s*\S+", text)
    total = sum(text_columns(token) for token in tokens) or 1
    if end is None:
        end = start + total / 14.64
    span = end - start

    out: list[dict] = []
    consumed = 0
    for token in tokens:
        token_start = start + span * consumed / total
        consumed += text_columns(token)
        token_end = start + span * consumed / total
        word: dict = {
            "start": token_start,
            "end": token_end,
            "word": token,
            "probability": 1.0,
        }
        if speaker is not None:
            word["speaker"] = speaker
        out.append(word)
    return out


def segment(text: str, **kwargs) -> dict:
    word_list = words(text, **kwargs)
    out: dict = {
        "start": word_list[0]["start"],
        "end": word_list[-1]["end"],
        "text": text,
        "words": word_list,
    }
    if kwargs.get("speaker") is not None:
        out["speaker"] = kwargs["speaker"]
    return out


def joined(cues: list[dict]) -> str:
    return "".join(str(word["word"]) for cue in cues for word in cue["words"])


def tok(text: str, start: float, end: float, speaker: int | None = None):
    return _make_token({"word": text, "start": start, "end": end}, speaker)


def check_invariants(cues: list[dict], limits, *, allow_violations: bool = False) -> None:
    """Every hard condition from spec section 4.2, on every cue.

    The structural conditions always hold.  ``allow_violations`` relaxes
    only the width / line-count / duration bounds, which the escape hatch
    may legitimately break for a single token that is itself wider than a
    line or longer than max_duration -- spec 4.2 permits exactly that, and
    the stats count it.
    """
    previous_end = None
    for cue in cues:
        text = cue["text"]
        # These never bend.  A blank cue is numbered differently by the
        # Python and JS SRT writers, and a blank line terminates an
        # SRT/VTT cue block, which silently truncates the file.
        assert text.strip(), "a blank cue is numbered differently by the two SRT writers"
        assert "\n\n" not in text, "a blank line terminates an SRT/VTT cue block"
        assert not text.startswith("\n") and not text.endswith("\n")
        assert cue["words"], "a cue must carry its own words"
        assert abs(cue["start"] - float(cue["words"][0]["start"])) < 1e-9
        if previous_end is not None:
            assert cue["start"] >= previous_end - 1e-9, "cues must not overlap"
        previous_end = cue["end"]

        duration = cue["end"] - cue["start"]
        assert duration >= 0

        if allow_violations:
            continue

        lines = text.split("\n")
        widths = [text_columns(line) for line in lines]
        assert len(lines) <= limits.max_lines, (lines, limits.max_lines)
        assert all(width <= limits.line_columns for width in widths), widths
        assert duration <= limits.max_duration + 1e-9, duration


def has_unsplittable_token(word_list: list[dict], limits) -> bool:
    """Is any single word wider than one line, or longer than a cue?

    Such a word cannot be wrapped or split, so the escape hatch has to
    emit it as-is.  That is the one sanctioned way to exceed the limits.
    """
    for word in word_list:
        if text_columns(str(word["word"]).strip()) > limits.line_columns:
            return True
        if float(word["end"]) - float(word["start"]) > limits.max_duration:
            return True
    return False


# --- character width ----------------------------------------------------


def test_char_columns_counts_east_asian_wide_as_two():
    assert char_columns("a") == 1
    assert char_columns("好") == 2
    assert char_columns("Ａ") == 2, "fullwidth Latin is two columns"
    assert char_columns(" ") == 1


def test_char_columns_ignores_combining_marks():
    # "e" + COMBINING ACUTE renders as one glyph one column wide.
    assert char_columns("́") == 0
    assert text_columns("é") == 1


def test_char_columns_treats_ambiguous_width_as_one():
    # The one arbitrary call in the module, kept identical to the
    # validated reference implementation.
    assert char_columns("±") == 1
    assert char_columns("§") == 1


def test_text_columns_matches_the_published_cjk_figure():
    # 16 Chinese characters, the Netflix per-line limit, is 32 columns.
    line = "所以我們認為這比部分依賴圖便宜。"
    assert len(line) == 16
    assert text_columns(line) == 32


def test_text_columns_handles_mixed_scripts():
    assert text_columns("這個 API 很好用") == 15


# --- language profiles --------------------------------------------------


@pytest.mark.parametrize("language", ["zh", "Chinese", "ja", "Japanese", "ko", "yue"])
def test_profile_for_picks_cjk(language):
    assert profile_for(language) is CJK_PROFILE


@pytest.mark.parametrize("language", ["en", "English", "French", "de", None, "", "nonsense"])
def test_profile_for_falls_back_to_latin(language):
    assert profile_for(language) is LATIN_PROFILE


def test_resolve_limits_converts_cjk_characters_to_columns():
    latin = resolve_limits(SegmentationOptions(), "en")
    assert (latin.line_chars, latin.line_columns) == (42, 42)
    assert latin.columns_per_second == 20.0

    cjk = resolve_limits(SegmentationOptions(), "zh")
    assert (cjk.line_chars, cjk.line_columns) == (16, 32)
    assert cjk.columns_per_second == 18.0
    assert cjk.cue_columns == 64


def test_resolve_limits_honours_an_explicit_line_width():
    limits = resolve_limits(SegmentationOptions(max_line_chars=20), "en")
    assert limits.line_columns == 20
    assert limits.cue_columns == 40


def test_blank_settings_fields_are_clamped_to_something_usable():
    # config._coerce_value turns a blank Settings field into 0 for a bare
    # int and 0.0 for a bare float.  max_lines=0 would make every cue
    # infeasible and emit one cue per word.
    options = SegmentationOptions(max_lines=0, max_duration=0.0, max_line_chars=0)
    # A blank field falls back to the field's own default, not to the
    # minimum -- 0 means "unset", not "zero lines".
    assert options.max_lines == 2
    assert options.max_duration == 7.0
    assert options.max_line_chars is None
    # A genuinely hostile value is clamped rather than defaulted.
    assert SegmentationOptions(max_lines=-3).max_lines == 1
    assert SegmentationOptions(max_lines=1).max_lines == 1


def test_min_duration_is_never_above_max_duration():
    options = SegmentationOptions(max_duration=2.0, min_duration=5.0)
    assert options.min_duration == 2.0


# --- line wrapping ------------------------------------------------------


def test_wrap_text_returns_a_single_line_when_it_fits():
    assert wrap_text("Hello world", max_columns=42) == "Hello world"


def test_wrap_text_balances_two_lines():
    out = wrap_text("If we have a more accurate estimation of a main effect, it can reduce,", max_columns=42)
    assert out == "If we have a more accurate estimation\nof a main effect, it can reduce,"
    assert [text_columns(line) for line in out.split("\n")] == [37, 32]


def test_wrap_text_charges_the_prefix_to_the_first_line():
    # "Hello there friend" is 18 columns and fits on one line alone; with
    # a 12-column speaker prefix the first line has to give way.
    assert wrap_text("Hello there friend", max_columns=20) == "Hello there friend"
    out = wrap_text("Hello there friend", max_columns=20, prefix_columns=12)
    # Not "Hello there\nfriend": 12 + 11 = 23 would overflow line 1.
    assert out == "Hello\nthere friend"
    assert text_columns(out.split("\n")[0]) + 12 <= 20
    assert text_columns(out.split("\n")[1]) <= 20


def test_wrap_text_prefers_a_break_after_punctuation_over_perfect_balance():
    out = wrap_text("So we argue that this, it is cheaper than the partial dependence plot.", max_columns=42)
    assert out.split("\n")[0].endswith("cheaper")


def test_wrap_text_returns_none_when_no_legal_break_exists():
    assert wrap_text("supercalifragilisticexpialidocious", max_columns=5) is None
    assert wrap_text("one two", max_columns=2) is None


def test_wrap_text_never_emits_a_blank_line_or_a_double_newline():
    # Runs of whitespace are consumed by the break, so neither line can
    # start or end blank even when the input is full of double spaces.
    out = wrap_text("alpha  bravo  charlie", max_columns=14)
    assert out == "alpha  bravo\ncharlie"
    assert "\n\n" not in out
    assert all(line.strip() for line in out.split("\n"))


def test_wrap_text_never_exceeds_max_lines():
    out = wrap_text("one two three four five six seven eight", max_columns=10, max_lines=2)
    assert out is None or len(out.split("\n")) <= 2


def test_wrap_text_never_splits_a_latin_word():
    out = wrap_text("alpha bravo charlie delta", max_columns=14)
    assert out is not None
    for line in out.split("\n"):
        for word in line.split(" "):
            assert word in "alpha bravo charlie delta".split(" ")


def test_wrap_text_breaks_cjk_between_any_two_characters():
    out = wrap_text("所以我們認為這比部分依賴圖便宜而且比真實實驗便宜很多", max_columns=32, cjk=True)
    assert out is not None
    assert len(out.split("\n")) == 2
    assert all(text_columns(line) <= 32 for line in out.split("\n"))
    assert out.replace("\n", "") == "所以我們認為這比部分依賴圖便宜而且比真實實驗便宜很多"


def test_wrap_text_keeps_closing_punctuation_off_the_line_start():
    out = wrap_text("所以我們認為這比部分依賴圖便宜，而且比真實實驗便宜很多。", max_columns=32, cjk=True)
    assert out is not None
    for line in out.split("\n")[1:]:
        assert line[0] not in "。，、；：！？"


def test_wrap_text_handles_an_empty_string():
    assert wrap_text("", max_columns=42) == ""
    assert wrap_text("   ", max_columns=42) == ""


# --- runs ---------------------------------------------------------------


def test_build_runs_splits_on_a_long_gap():
    limits = resolve_limits(SegmentationOptions(run_gap=1.0), "en")
    runs = build_runs([tok(" a", 0, 1), tok(" b", 1, 2), tok(" c", 4, 5)], limits)
    assert [[t.text for t in run] for run in runs] == [[" a", " b"], [" c"]]


def test_build_runs_splits_on_a_speaker_change():
    limits = resolve_limits(SegmentationOptions(), "en")
    runs = build_runs([tok(" a", 0, 1, 0), tok(" b", 1, 2, 1)], limits)
    assert len(runs) == 2


def test_build_runs_does_not_split_on_a_missing_speaker():
    limits = resolve_limits(SegmentationOptions(), "en")
    runs = build_runs([tok(" a", 0, 1), tok(" b", 1, 2)], limits)
    assert len(runs) == 1


def test_build_runs_tolerates_zero_duration_words():
    # adjust_timestamps collapses a word past a chunk cutoff to zero
    # duration, so this is the normal case rather than an exotic one.
    limits = resolve_limits(SegmentationOptions(), "en")
    runs = build_runs([tok(" a", 1.0, 1.0), tok(" b", 1.0, 1.0)], limits)
    assert len(runs) == 1


# --- the real sentence --------------------------------------------------


def test_real_sentence_is_cut_into_compliant_cues():
    options = SegmentationOptions()
    limits = resolve_limits(options, "en")
    source = [
        {
            "start": REAL_START,
            "end": REAL_END,
            "text": REAL_SENTENCE,
            "words": words(REAL_SENTENCE, start=REAL_START, end=REAL_END),
        }
    ]
    cues, stats = resegment(source, options, language="en")

    assert len(cues) == 4
    check_invariants(cues, limits)
    for cue in cues:
        duration = cue["end"] - cue["start"]
        assert duration >= limits.min_duration
        assert text_columns(cue["text"].replace("\n", "")) / duration <= limits.columns_per_second

    # Every interior boundary lands after punctuation, and most after a
    # full stop -- which is what "切點落在句尾" asks for.  The reference
    # output in spec 3.4 breaks the same way.
    interior = [cue["text"].rstrip()[-1] for cue in cues[:-1]]
    assert all(char in ".?!,;:" for char in interior), interior
    assert sum(1 for char in interior if char in ".?!") >= 2

    assert joined(cues) == REAL_SENTENCE
    assert stats.cues_out == 4
    assert stats.over_duration == 0
    assert stats.over_lines == 0
    assert stats.over_reading_speed == 0


def test_real_sentence_text_is_conserved_at_every_line_width():
    options_source = words(REAL_SENTENCE, start=REAL_START, end=REAL_END)
    for chars in (12, 20, 32, 42, 60):
        options = SegmentationOptions(max_line_chars=chars)
        cues, _ = resegment(
            [{"start": REAL_START, "end": REAL_END, "text": REAL_SENTENCE, "words": options_source}],
            options,
            language="en",
        )
        assert joined(cues) == REAL_SENTENCE, chars


# --- text conservation, by property -------------------------------------


def test_text_is_conserved_across_randomised_inputs():
    rng = random.Random(0xC0FFEE)
    alphabet = "abcdefghijklmnopqrstuvwxyz"
    punctuation = ".,;:?!"

    for case in range(200):
        cjk = rng.random() < 0.3
        count = rng.randint(1, 200)

        if cjk:
            pool = "你好世界測試中文字幕切段規範閱讀速度標點符號"
            text = "".join(rng.choice(pool) for _ in range(count))
            if rng.random() < 0.5:
                index = rng.randrange(len(text))
                text = text[:index] + rng.choice("。，！？") + text[index:]
        else:
            pieces = []
            for _ in range(count):
                length = rng.randint(1, 15)
                word = "".join(rng.choice(alphabet) for _ in range(length))
                if rng.random() < 0.15:
                    word += rng.choice(punctuation)
                pieces.append(word)
            text = " ".join(pieces)

        word_list = words(text, start=rng.uniform(0, 100), cjk=cjk)
        # Inject the degenerate timings adjust_timestamps really produces.
        if word_list and rng.random() < 0.3:
            victim = rng.randrange(len(word_list))
            word_list[victim]["end"] = word_list[victim]["start"]
        if word_list and rng.random() < 0.2:
            victim = rng.randrange(len(word_list))
            word_list[victim]["start"] = word_list[victim]["end"] + rng.uniform(0, 2)

        speaker = rng.choice([None, 0, 1])
        source = [
            {
                "start": word_list[0]["start"],
                "end": word_list[-1]["end"],
                "text": text,
                "words": word_list,
                **({"speaker": speaker} if speaker is not None else {}),
            }
        ]
        chars = rng.choice([1, 2, 8, 16, 42, 80])
        language = "zh" if cjk else "en"
        options = SegmentationOptions(max_line_chars=chars)
        limits = resolve_limits(options, language)
        cues, stats = resegment(source, options, language=language)

        expected = "".join(str(w["word"]) for w in word_list)
        assert joined(cues) == expected, (case, chars, cjk)

        # A single word wider than one line (or longer than max_duration)
        # cannot be wrapped or split, so the escape hatch emits it as-is.
        # A narrow max_line_chars forces that on nearly every word, which
        # is exactly where a naive solver raises or loops forever.
        relaxed = has_unsplittable_token(word_list, limits)
        check_invariants(cues, limits, allow_violations=relaxed)
        if not relaxed:
            assert stats.over_lines == 0, (case, chars)
            assert stats.over_line_width == 0, (case, chars)


# --- timing -------------------------------------------------------------


def test_short_cue_is_stretched_into_the_following_silence():
    options = SegmentationOptions()
    source = [segment("Hi.", start=0.0, end=0.2), segment("Then a much longer sentence follows here.", start=9.0)]
    cues, stats = resegment(source, options, language="en")
    assert cues[0]["start"] == 0.0
    assert cues[0]["end"] >= options.min_duration
    assert cues[0]["end"] <= cues[1]["start"] - options.min_gap + 1e-9
    assert stats.stretched >= 1


def test_stretching_never_runs_past_the_next_cue():
    # run_gap is lowered so the 0.3 s gap splits the run; otherwise both
    # segments merge into a single cue and there is nothing to overlap.
    options = SegmentationOptions(run_gap=0.2)
    source = [segment("Hi.", start=0.0, end=0.1), segment("Next.", start=0.4, end=0.5)]
    cues, _ = resegment(source, options, language="en")
    assert len(cues) == 2
    # The gap to the next cue is smaller than min_duration, so the stretch
    # is cut short rather than overlapping.
    assert cues[0]["end"] < options.min_duration
    assert cues[0]["end"] <= cues[1]["start"] - options.min_gap + 1e-9


def test_a_long_silence_inside_a_cue_is_capped_at_max_duration():
    # Few characters over a long span means silence or applause: do not
    # split, cap the cue instead.
    options = SegmentationOptions()
    word_list = [
        {"start": 0.0, "end": 0.4, "word": "Thanks.", "probability": 1.0},
        {"start": 25.0, "end": 25.4, "word": " Right.", "probability": 1.0},
    ]
    cues, _ = resegment([{"start": 0.0, "end": 25.4, "text": "Thanks. Right.", "words": word_list}], options, language="en")
    for cue in cues:
        assert cue["end"] - cue["start"] <= options.max_duration + 1e-9


def test_a_single_word_longer_than_max_duration_keeps_its_span():
    # Truncating would hide a word; count the violation instead.
    options = SegmentationOptions()
    word_list = [{"start": 0.0, "end": 12.0, "word": "Mmmmmm", "probability": 1.0}]
    cues, stats = resegment([{"start": 0.0, "end": 12.0, "text": "Mmmmmm", "words": word_list}], options, language="en")
    assert len(cues) == 1
    assert cues[0]["end"] - cues[0]["start"] == pytest.approx(12.0)
    assert stats.over_duration == 1


def test_cue_start_always_equals_its_first_word_start():
    options = SegmentationOptions()
    cues, _ = resegment([segment(REAL_SENTENCE, start=REAL_START, end=REAL_END)], options, language="en")
    for cue in cues:
        assert cue["start"] == cue["words"][0]["start"]


# --- speakers -----------------------------------------------------------


def test_no_cue_spans_two_speakers():
    options = SegmentationOptions()
    source = [
        segment("Hello there, how are you doing today my friend?", start=0.0, speaker=0),
        segment("I am doing very well indeed, thank you for asking.", start=8.0, speaker=1),
    ]
    cues, _ = resegment(source, options, language="en")
    for cue in cues:
        speakers = {word.get("speaker") for word in cue["words"]}
        assert len(speakers) == 1


def test_speaker_label_appears_only_on_the_first_cue_of_a_stretch():
    options = SegmentationOptions()
    source = [
        segment(REAL_SENTENCE, start=REAL_START, end=REAL_END, speaker=0),
        segment("A completely different person replies at some length here.", start=REAL_END + 0.5, speaker=1),
    ]
    cues, _ = resegment(source, options, language="en", label_for=lambda n: f"Speaker {n + 1}")

    labelled = [index for index, cue in enumerate(cues) if "speaker_label" in cue]
    assert len(labelled) == 2, "one label per speaker stretch"
    assert labelled[0] == 0
    assert cues[labelled[0]]["speaker_label"] == "Speaker 1"
    assert cues[labelled[1]]["speaker_label"] == "Speaker 2"
    # Every cue still carries the speaker index, so a future UI can colour
    # them even where the label is thinned out.
    assert all("speaker" in cue for cue in cues)


def test_speaker_stretch_survives_a_gap_induced_run_split():
    # The same person pausing for three seconds must not be re-labelled.
    options = SegmentationOptions()
    source = [
        segment("First thing I want to say is this one.", start=0.0, speaker=0),
        segment("And now the second thing after a pause.", start=12.0, speaker=0),
    ]
    cues, _ = resegment(source, options, language="en", label_for=lambda n: f"Speaker {n + 1}")
    assert sum(1 for cue in cues if "speaker_label" in cue) == 1


def test_a_labelled_cue_first_line_fits_with_the_prefix_included():
    options = SegmentationOptions()
    limits = resolve_limits(options, "en")
    cues, _ = resegment(
        [segment(REAL_SENTENCE, start=REAL_START, end=REAL_END, speaker=0)],
        options,
        language="en",
        label_for=lambda n: f"Speaker {n + 1}",
    )
    first = cues[0]
    assert "speaker_label" in first
    prefix_columns = text_columns(f"[{first['speaker_label']}] ")
    assert text_columns(first["text"].split("\n")[0]) + prefix_columns <= limits.line_columns


def test_no_labels_at_all_without_a_label_callable():
    options = SegmentationOptions()
    cues, _ = resegment([segment("Hello there my friend.", speaker=0)], options, language="en")
    assert all("speaker_label" not in cue for cue in cues)


# --- CJK ----------------------------------------------------------------


def test_cjk_cues_respect_the_sixteen_character_line():
    options = SegmentationOptions()
    limits = resolve_limits(options, "zh")
    text = "所以我們認為這比部分依賴圖便宜，而且比真實實驗便宜很多，這是我們的結論。"
    cues, _ = resegment([segment(text, cjk=True)], options, language="zh")
    check_invariants(cues, limits)
    for cue in cues:
        for line in cue["text"].split("\n"):
            assert text_columns(line) <= 32
            assert len(line) <= 16


def test_cjk_prefers_breaking_after_punctuation():
    options = SegmentationOptions()
    text = "所以我們認為這比部分依賴圖便宜。而且比真實實驗便宜很多。這就是我們的結論。"
    cues, _ = resegment([segment(text, cjk=True)], options, language="zh")
    interior = [cue["text"].rstrip()[-1] for cue in cues[:-1]]
    assert all(char in "。，、；：！？" for char in interior), interior


def test_cjk_without_punctuation_still_produces_legal_cues():
    options = SegmentationOptions()
    limits = resolve_limits(options, "zh")
    text = "所以我們認為這比部分依賴圖便宜而且比真實實驗便宜很多這就是我們的結論"
    cues, _ = resegment([segment(text, cjk=True)], options, language="zh")
    check_invariants(cues, limits)
    assert joined(cues) == text


def test_cjk_never_gains_spaces_between_characters():
    options = SegmentationOptions()
    cues, _ = resegment([segment("你好世界", cjk=True)], options, language="zh")
    assert "".join(cue["text"] for cue in cues) == "你好世界"


# --- the no-words fallback ---------------------------------------------


def test_interpolate_words_keeps_latin_separators():
    out = interpolate_words({"start": 0.0, "end": 4.0, "text": "Hello there friend again"})
    assert "".join(word["word"] for word in out) == "Hello there friend again"
    assert all(word["interpolated"] for word in out)
    assert out[0]["start"] == 0.0
    assert out[-1]["end"] == pytest.approx(4.0)


def test_interpolate_words_splits_cjk_per_character():
    out = interpolate_words({"start": 0.0, "end": 2.0, "text": "你好世界"})
    assert [word["word"] for word in out] == ["你", "好", "世", "界"]
    assert "".join(word["word"] for word in out) == "你好世界"


def test_interpolate_words_returns_nothing_for_blank_text():
    assert interpolate_words({"start": 0.0, "end": 1.0, "text": "   "}) == []


def test_segments_without_words_fall_back_to_interpolation():
    options = SegmentationOptions()
    limits = resolve_limits(options, "en")
    text = "This segment never got word timestamps at all, so its times are estimated."
    cues, stats = resegment([{"start": 0.0, "end": 6.0, "text": text, "words": []}], options, language="en")
    assert stats.interpolated_segments == 1
    assert joined(cues) == text
    check_invariants(cues, limits)


def test_mixed_word_and_wordless_segments_need_no_special_case():
    options = SegmentationOptions()
    source = [
        segment("The first segment has real word timestamps here.", start=0.0),
        {"start": 10.0, "end": 16.0, "text": "The second one does not have any words.", "words": []},
    ]
    cues, stats = resegment(source, options, language="en")
    assert stats.interpolated_segments == 1
    assert joined(cues) == (
        "The first segment has real word timestamps here."
        "The second one does not have any words."
    )


def test_an_empty_wordless_segment_yields_no_cue():
    options = SegmentationOptions()
    cues, _ = resegment([{"start": 0.0, "end": 1.0, "text": "", "words": []}], options, language="en")
    assert cues == []


# --- cue shape ----------------------------------------------------------


def test_cue_keys_are_an_explicit_whitelist():
    options = SegmentationOptions()
    cues, _ = resegment(
        [segment("Hello there my friend, nice to see you.", speaker=0)],
        options,
        language="en",
        label_for=lambda n: f"Speaker {n + 1}",
    )
    assert set(cues[0]) == {"start", "end", "text", "words", "speaker", "speaker_label"}
    assert set(cues[-1]) <= {"start", "end", "text", "words", "speaker", "speaker_label"}


def test_stray_segment_keys_never_reach_a_cue():
    # diarization's _split_by_speaker spreads {**segment}, which drags
    # expand_amount onto every piece with a value that no longer
    # describes it.  Segmentation builds cues from a whitelist instead.
    options = SegmentationOptions()
    source = segment("Hello there my friend.", start=0.0)
    source["expand_amount"] = 1.5
    source["no_speech_prob"] = 0.1
    cues, _ = resegment([source], options, language="en")
    for cue in cues:
        assert "expand_amount" not in cue
        assert "no_speech_prob" not in cue


def test_input_segments_are_not_mutated():
    options = SegmentationOptions()
    source = [segment(REAL_SENTENCE, start=REAL_START, end=REAL_END)]
    before_text = source[0]["text"]
    before_count = len(source[0]["words"])
    resegment(source, options, language="en")
    assert source[0]["text"] == before_text
    assert len(source[0]["words"]) == before_count
    assert "speaker_label" not in source[0]


# --- degenerate inputs --------------------------------------------------


def test_no_segments_at_all():
    cues, stats = resegment([], SegmentationOptions(), language="en")
    assert cues == []
    assert stats.cues_out == 0


def test_a_single_word():
    options = SegmentationOptions()
    cues, _ = resegment([segment("Yes.")], options, language="en")
    assert len(cues) == 1
    assert cues[0]["text"] == "Yes."


def test_a_word_wider_than_the_whole_cue_budget_is_counted_not_hidden():
    options = SegmentationOptions(max_line_chars=4)
    cues, stats = resegment([segment("supercalifragilistic")], options, language="en")
    assert joined(cues) == "supercalifragilistic"
    assert stats.over_line_width == 1


def test_all_whitespace_words_produce_no_cue():
    options = SegmentationOptions()
    word_list = [{"start": 0.0, "end": 1.0, "word": "   ", "probability": 1.0}]
    cues, _ = resegment([{"start": 0.0, "end": 1.0, "text": "   ", "words": word_list}], options, language="en")
    assert cues == []


# --- statistics and the result wrapper ---------------------------------


def test_log_message_is_stable():
    stats = SegmentationStats(
        cues_in=408,
        cues_out=727,
        runs=146,
        words_total=7011,
        over_duration=0,
        over_lines=0,
        over_reading_speed=11,
        stretched=24,
        longest_duration=7.0,
    )
    assert stats.log_message() == (
        "subtitle segmentation: 408 -> 727 cues in 146 runs, 0 over duration, "
        "0 over line count, 11 over reading speed, 24 stretched, longest 7.00s"
    )


def test_apply_to_result_rewrites_segments_text_and_metadata():
    options = SegmentationOptions()
    result = {
        "segments": [segment(REAL_SENTENCE, start=REAL_START, end=REAL_END)],
        "text": "stale",
        "language": "en",
    }
    stats = apply_to_result(result, options, language="en")

    assert len(result["segments"]) == stats.cues_out == 4
    # The top-level text was never recomputed before this feature, so it
    # was stale for any run that replaced segments.
    assert result["text"] == REAL_SENTENCE
    assert result["language"] == "en", "untouched"

    meta = result["segmentation"]
    assert meta["version"] == 1
    assert meta["profile"] == "latin"
    assert meta["max_line_chars"] == 42
    assert meta["line_columns"] == 42
    assert meta["max_lines"] == 2
    assert meta["stats"]["cues_out"] == 4


def test_apply_to_result_records_cjk_parameters():
    result = {"segments": [segment("所以我們認為這比部分依賴圖便宜。", cjk=True)], "text": "", "language": "zh"}
    apply_to_result(result, SegmentationOptions(), language="zh")
    meta = result["segmentation"]
    assert meta["profile"] == "cjk"
    assert (meta["max_line_chars"], meta["line_columns"]) == (16, 32)
    assert meta["reading_speed_columns_per_second"] == 18.0


# --- the pipeline interlock ---------------------------------------------
#
# transcriber.py imports faster_whisper at module level, so CI cannot
# import it.  These read its source instead, because the two facts they
# pin are the ones whose absence silently corrupts output files.


def _transcriber_source() -> str:
    return (Path(__file__).resolve().parents[1] / "transcriber.py").read_text(encoding="utf-8")


def test_writers_are_not_asked_to_re_wrap_segmented_text():
    # Segmentation bakes its line breaks into the cue text.  Passing
    # max_line_width to the writers as well makes _wrap_text re-wrap text
    # that already contains "\n" -- it counts a newline as one printable
    # character, so it mis-measures every line after the first and can
    # emit "\n\n", which terminates the SRT/VTT cue block and makes
    # transcript-reader.js's parseSrt silently drop the rest of the file.
    source = _transcriber_source()
    assert "wrap_width = None if cfg.subtitle_segmentation else cfg.max_line_width" in source
    assert "max_line_width=wrap_width" in source
    # ...and nothing still hands the raw config value straight through.
    assert "max_line_width=cfg.max_line_width" not in source


def test_word_timestamps_stay_gated_on_the_two_features():
    # Omitting the key entirely is what keeps the decode bit-for-bit
    # identical with both features off: faster-whisper's own default is
    # False, and add_word_timestamps() rewrites segment start/end.
    source = _transcriber_source()
    assert "if cfg.diarize or cfg.subtitle_segmentation:" in source
    assert 'options["word_timestamps"] = True' in source
    assert 'options["word_timestamps"] = False' not in source


def test_segmentation_runs_after_diarization():
    # Cues are built from runs of a single speaker, so a word has to know
    # who said it first.  The reverse order would let assign_speakers
    # re-split the sized cues and overwrite their word-accurate edges.
    source = _transcriber_source()
    assert source.index("self._run_diarization(result, input_path)") < source.index(
        "self._run_segmentation(result)"
    )


def test_segmentation_thins_labels_the_same_way_diarization_does():
    # Two implementations of one rule: diarization labels the first
    # segment of each turn, segmentation the first cue of each turn.  This
    # pins them to the same answer for the same speaker sequence.
    from whisperflow.diarization import label_speaker_turns

    options = SegmentationOptions()
    source = [
        segment("First speaker says something reasonably long here.", start=0.0, speaker=0),
        segment("Then the first speaker carries on after a pause.", start=12.0, speaker=0),
        segment("Now the second speaker replies at some length.", start=24.0, speaker=1),
        segment("And the first speaker comes back again at the end.", start=36.0, speaker=0),
    ]
    cues, _ = resegment(source, options, language="en", label_for=lambda n: f"Speaker {n + 1}")

    # What diarization would have produced for the same speaker run.
    mirror = [{"speaker": cue.get("speaker")} for cue in cues]
    label_speaker_turns(mirror, "Speaker {n}")

    assert [cue.get("speaker_label") for cue in cues] == [
        entry.get("speaker_label") for entry in mirror
    ]
    # Three turns: 0, 1, 0 -- the pause inside the first turn must not
    # start a new one.
    assert sum(1 for cue in cues if "speaker_label" in cue) == 3
