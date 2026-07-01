from gateway.ops import (
    Botlist,
    Censor,
    CensorDisposition,
    CensorLevel,
    ContentSanitizer,
    PermissionGate,
    PrivilegeLevel,
    RateLimiter,
    is_bot_enabled,
    requires_at_mention,
    set_bot_enabled,
)
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


def test_permission_gate_master_required_and_claim_code() -> None:
    gate = PermissionGate(masters={"user:master"}, claim_code="abcd1234")

    assert PrivilegeLevel.EVERYONE < PrivilegeLevel.MASTER
    assert gate.allowed("user:master", PrivilegeLevel.MASTER)
    assert not gate.allowed("user:normal", PrivilegeLevel.MASTER)
    assert not gate.claim_master("user:normal", "bad-code")
    assert not gate.allowed("user:normal", PrivilegeLevel.MASTER)

    assert gate.rotating_claim_code() == "abcd1234"
    assert gate.claim_master("user:normal", "abcd1234")
    assert gate.allowed("user:normal", PrivilegeLevel.MASTER)


def test_content_sanitizer_removes_mass_mentions_and_rewrites_url() -> None:
    sanitizer = ContentSanitizer()

    result = sanitizer.sanitize_outbound("ping @everyone see https://example.com/path.")

    assert "@everyone" not in result
    assert "https://example.com/path" not in result
    assert "https[:]//example[.]com/path" in result
    assert t("ops.sanitizer.url", url="https[:]//example[.]com/path") in result
