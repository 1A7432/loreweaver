import json

import pytest

from gateway.ops import (
    Botlist,
    Censor,
    CensorDisposition,
    CensorLevel,
    ContentSanitizer,
    RateLimiter,
    censor_from_settings,
    is_bot_enabled,
    load_wordlist,
    requires_at_mention,
    set_bot_enabled,
)
from infra.config import CensorSettings
from infra.i18n import t
from infra.store import Store


def test_rate_limiter_capacity_and_deterministic_refill() -> None:
    current = 0.0

    def now() -> float:
        return current

    limiter = RateLimiter(capacity=2, refill_per_sec=1.0, now=now)

    assert limiter.allow("user:1")
    assert limiter.allow("user:1")
    assert not limiter.allow("user:1")

    current = 0.5
    assert not limiter.allow("user:1")

    current = 1.0
    assert limiter.allow("user:1")
    assert not limiter.allow("user:1")


def test_censor_blocks_seeded_bad_word_and_masks_cleaned_text() -> None:
    result = Censor({"badword": int(CensorLevel.DANGER)}).review("keep badword away")

    assert not result.allowed
    assert result.level == int(CensorLevel.DANGER)
    assert result.hits == ["badword"]
    assert t("ops.censor.mask") in result.cleaned
    assert "badword" not in result.cleaned.lower()
    assert result.disposition & CensorDisposition.BLOCK


def test_censor_passes_clean_text_unchanged() -> None:
    text = "plain table chatter"
    result = Censor({"badword": int(CensorLevel.DANGER)}).review(text)

    assert result.allowed
    assert result.cleaned == text
    assert result.level == int(CensorLevel.NONE)
    assert result.hits == []
    assert result.disposition == CensorDisposition.ALLOW


def test_censor_defeats_spacing_punctuation_and_fullwidth_bypass() -> None:
    # Regression (#6): normalization (NFKC + casefold) plus inter-letter separator
    # tolerance closes the "b a d w o r d" / "b.a.d..." / fullwidth / mixed-case holes
    # a naive `re.escape(word)` IGNORECASE matcher left open.
    censor = Censor({"badword": int(CensorLevel.DANGER)})

    for bypass in ("keep b a d w o r d away", "b.a.d.w.o.r.d now", "BADWORD here", "ｂａｄｗｏｒｄ"):
        result = censor.review(bypass)
        assert not result.allowed, bypass
        assert result.hits == ["badword"], bypass
        assert "badword" not in result.cleaned.lower(), bypass
        assert t("ops.censor.mask") in result.cleaned, bypass


def test_censor_word_boundary_avoids_substring_overmatch() -> None:
    # Regression (#6): whole-word (\w-boundary) matching avoids the Scunthorpe problem —
    # a banned word must not fire when it is merely a substring of an innocent word.
    censor = Censor({"cat": int(CensorLevel.NOTICE)})

    for innocent in ("category", "concatenate", "scatter"):
        result = censor.review(innocent)
        assert result.allowed
        assert result.hits == []
        assert result.cleaned == innocent

    # ...but a real standalone occurrence (any case / trailing punctuation) still hits.
    hit = censor.review("a CAT.")
    assert hit.hits == ["cat"]
    assert t("ops.censor.mask") in hit.cleaned


def test_censor_with_no_wordlist_is_an_explicit_noop_not_a_hidden_default() -> None:
    # Regression: `Censor()` used to fall back to a placeholder {"badword": DANGER}
    # wordlist, giving a false impression of moderation. An unconfigured Censor
    # must pass EVERYTHING through unchanged -- including words that used to be
    # the old built-in placeholder -- via the documented `not self._patterns`
    # early-return, not a shrunken-but-still-real wordlist.
    text = "this has badword and a cat and every other word in it"
    for censor in (Censor(), Censor(None), Censor({})):
        result = censor.review(text)
        assert result.allowed
        assert result.cleaned == text
        assert result.hits == []
        assert result.level == int(CensorLevel.NONE)
        assert result.disposition == CensorDisposition.ALLOW


def test_load_wordlist_blank_inputs_returns_empty_dict() -> None:
    assert load_wordlist() == {}
    assert load_wordlist(path="", inline="") == {}


def test_load_wordlist_inline_parses_word_level_pairs_and_defaults_to_notice() -> None:
    wordlist = load_wordlist(inline=" slur : 5 , mild-word,badlevel:not-a-number ")

    assert wordlist == {
        "slur": int(CensorLevel.FORBIDDEN),
        "mild-word": int(CensorLevel.NOTICE),
        "badlevel": int(CensorLevel.NOTICE),
    }


def test_load_wordlist_file_parses_json_object_and_combines_with_inline(tmp_path) -> None:
    wordlist_path = tmp_path / "wordlist.json"
    wordlist_path.write_text(json.dumps({"fileword": 4, "shared": 1}), encoding="utf-8")

    # `inline` entries win on a key collision with the file.
    wordlist = load_wordlist(path=str(wordlist_path), inline="shared:5,inlineword:2")

    assert wordlist == {
        "fileword": int(CensorLevel.DANGER),
        "shared": int(CensorLevel.FORBIDDEN),
        "inlineword": int(CensorLevel.CAUTION),
    }


def test_load_wordlist_file_rejects_missing_invalid_json_and_non_object(tmp_path) -> None:
    with pytest.raises(ValueError):
        load_wordlist(path=str(tmp_path / "does-not-exist.json"))

    bad_json = tmp_path / "bad.json"
    bad_json.write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError):
        load_wordlist(path=str(bad_json))

    not_object = tmp_path / "list.json"
    not_object.write_text(json.dumps(["fileword"]), encoding="utf-8")
    with pytest.raises(ValueError):
        load_wordlist(path=str(not_object))


def test_censor_from_settings_configured_wordlist_masks_and_blocks() -> None:
    settings = CensorSettings(wordlist="badword:5")
    censor = censor_from_settings(settings)

    result = censor.review("keep badword away")

    assert not result.allowed
    assert result.hits == ["badword"]
    assert t("ops.censor.mask") in result.cleaned
    assert result.disposition & CensorDisposition.BLOCK


def test_censor_from_settings_default_empty_settings_is_explicit_noop() -> None:
    censor = censor_from_settings(CensorSettings())

    result = censor.review("badword is not filtered when unconfigured")

    assert result.allowed
    assert result.hits == []
    assert result.cleaned == "badword is not filtered when unconfigured"


async def test_bot_on_off_defaults_disabled_then_enabled() -> None:
    store = Store(":memory:")
    chat_key = "qq:group:42"
    try:
        assert not await is_bot_enabled(store, chat_key)

        await set_bot_enabled(store, chat_key, True)
        assert await is_bot_enabled(store, chat_key)

        await set_bot_enabled(store, chat_key, False)
        assert not await is_bot_enabled(store, chat_key)
    finally:
        store.close()


def test_requires_at_mention_for_group_like_chats_not_dms() -> None:
    assert requires_at_mention("group")
    assert requires_at_mention("channel")
    assert not requires_at_mention("dm")


def test_botlist_ignores_added_bot_ids() -> None:
    botlist = Botlist({"bot:1"})

    assert botlist.is_bot("bot:1")
    assert not botlist.is_bot("user:1")

    botlist.add("bot:2")
    assert botlist.is_bot("bot:2")


def test_content_sanitizer_removes_mass_mentions_and_rewrites_url() -> None:
    sanitizer = ContentSanitizer()

    result = sanitizer.sanitize_outbound("ping @everyone see https://example.com/path.")

    assert "@everyone" not in result
    assert "https://example.com/path" not in result
    assert "https[:]//example[.]com/path" in result
    assert t("ops.sanitizer.url", url="https[:]//example[.]com/path") in result
