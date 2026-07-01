from gateway.session import SessionSource


def test_chat_key_for_group_dm_and_thread() -> None:
    assert SessionSource(platform="qq", chat_id="42").chat_key() == "qq:group:42"
    assert SessionSource(platform="discord", chat_id="u1", chat_type="dm").chat_key() == "discord:dm:u1"
    assert (
        SessionSource(platform="discord", chat_id="c1", chat_type="channel", thread_id="t1").chat_key()
        == "discord:channel:c1:t1"
    )


def test_user_key_normalization() -> None:
    assert SessionSource(platform="qq", chat_id="42", user_id="100").user_key() == "qq:100"
    assert SessionSource(platform="qq", chat_id="42").user_key() == "qq:anon"


def test_same_room_sources_share_chat_key_but_have_distinct_user_key() -> None:
    first = SessionSource(platform="qq", chat_id="42", user_id="100")
    second = SessionSource(platform="qq", chat_id="42", user_id="200")

    assert first.chat_key() == second.chat_key()
    assert first.user_key() != second.user_key()
