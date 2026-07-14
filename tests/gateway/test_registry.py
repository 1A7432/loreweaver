from gateway.registry import AdapterContext, PlatformEntry, PlatformRegistry


class BuiltAdapter:
    def __init__(self, config, context) -> None:
        self.config = config
        self.context = context


CONTEXT = AdapterContext(services=object(), command_router=object())


def test_register_get_and_is_registered() -> None:
    registry = PlatformRegistry()
    entry = PlatformEntry(
        name="fake",
        label="Fake",
        adapter_factory=BuiltAdapter,
        check_fn=lambda: True,
    )

    registry.register(entry)

    assert registry.get("fake") is entry
    assert registry.is_registered("fake") is True
    assert registry.is_registered("missing") is False
    assert registry.all_entries() == [entry]


def test_create_adapter_builds_with_factory() -> None:
    registry = PlatformRegistry()
    registry.register(
        PlatformEntry(
            name="fake",
            label="Fake",
            adapter_factory=BuiltAdapter,
            check_fn=lambda: True,
        )
    )

    adapter = registry.create_adapter("fake", {"token": "x"}, CONTEXT)

    assert isinstance(adapter, BuiltAdapter)
    assert adapter.config == {"token": "x"}
    assert adapter.context is CONTEXT


def test_create_adapter_returns_none_when_check_fails_or_unknown() -> None:
    registry = PlatformRegistry()
    registry.register(
        PlatformEntry(
            name="fake",
            label="Fake",
            adapter_factory=BuiltAdapter,
            check_fn=lambda: False,
        )
    )

    assert registry.create_adapter("fake", {}, CONTEXT) is None
    assert registry.create_adapter("missing", {}, CONTEXT) is None
