"""Offline subprocess coverage for `python -m app --doctor`: the diagnostics mode that
exercises exactly what a frozen (PyInstaller) bundle tends to break — locale catalogs,
rulepacks, skills, and the resolved data dir — then exits 0 (or non-zero naming what's
missing). `scripts/package_server.py` shells the same `--doctor` flag against the built
binary as part of its build smoke, so this is the offline, source-mode baseline for it."""

from __future__ import annotations

import os
import re
import subprocess
import sys

import pytest

import app
from app import _run_doctor as _run_app_doctor
from infra.config import Settings
from infra.i18n import get_i18n


@pytest.fixture(autouse=True)
def _isolate_runtime_configuration(monkeypatch):
    """Direct doctor calls must not inherit a developer's real bot credentials."""
    for key in tuple(os.environ):
        if key.startswith("TRPG_"):
            monkeypatch.delenv(key)


def _run_doctor() -> tuple[int, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("TRPG_")}
    env["TRPG_ENV_FILE"] = os.devnull
    result = subprocess.run(
        [sys.executable, "-m", "app", "--doctor"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    return result.returncode, result.stdout + result.stderr


def test_doctor_source_mode_exits_zero_and_reports_builtins():
    returncode, output = _run_doctor()

    assert returncode == 0, output
    assert "coc7" in output, output
    assert "dnd5e" in output, output
    assert "en" in output, output
    assert "zh" in output, output


def test_doctor_reports_at_least_four_skills():
    returncode, output = _run_doctor()
    assert returncode == 0, output

    # e.g. "Skills: mature-mode, module-forge, ... (5)" — parse the trailing count.
    match = re.search(r"KP skills:.*\((\d+)\)", output)
    assert match is not None, output
    assert int(match.group(1)) >= 4, output


# --- P2: the Scribe cost advisory -------------------------------------------


def _doctor_stderr(capsys, settings) -> str:
    from app import _run_doctor
    from infra.i18n import get_i18n

    assert _run_doctor(settings, get_i18n(settings.locale)) == 0, "an advisory must never fail the check"
    return capsys.readouterr().err


def test_doctor_warns_when_a_subscription_quota_is_paying_for_bookkeeping(capsys):
    settings = Settings(locale="en")
    settings.llm.provider = "chatgpt"
    settings.llm.base_url = ""  # no proxy -> the real subscription OAuth path

    output = _doctor_stderr(capsys, settings)

    assert "SUBSCRIPTION quota" in output
    assert "TRPG_SCRIBE__" in output


def test_doctor_warns_about_flagship_prices_on_a_paid_provider(capsys):
    settings = Settings(locale="en")
    settings.llm.provider = "deepseek"

    output = _doctor_stderr(capsys, settings)

    assert "flagship prices" in output


def test_doctor_says_nothing_once_the_scribe_has_its_own_model(capsys):
    settings = Settings(locale="en")
    settings.llm.provider = "chatgpt"
    settings.scribe.chat_model = "deepseek-v4-flash"

    assert "TRPG_SCRIBE__" not in _doctor_stderr(capsys, settings)


def test_doctor_says_nothing_with_the_scribe_off(capsys):
    settings = Settings(locale="en")
    settings.llm.provider = "chatgpt"
    settings.scribe.enabled = False

    assert "TRPG_SCRIBE__" not in _doctor_stderr(capsys, settings)


def test_doctor_says_nothing_on_a_local_provider(capsys):
    # Nothing to save: the advice would be pure noise on a model you host yourself.
    settings = Settings(locale="en")
    settings.llm.provider = "ollama"

    assert "TRPG_SCRIBE__" not in _doctor_stderr(capsys, settings)


def test_the_advisory_is_localized(capsys):
    settings = Settings(locale="zh")
    settings.llm.provider = "chatgpt"

    output = _doctor_stderr(capsys, settings)

    assert "书记官" in output and "TRPG_SCRIBE__" in output


def test_provider_cost_class_names_what_an_operator_can_act_on():
    from infra.config import LLMSettings
    from infra.providers import provider_cost_class

    assert provider_cost_class(LLMSettings(provider="chatgpt")) == "subscription"
    assert provider_cost_class(LLMSettings(provider="supergrok")) == "subscription"
    # A `chatgpt` name WITH a base_url is an operator-run proxy, billed per token.
    assert provider_cost_class(LLMSettings(provider="chatgpt", base_url="https://proxy/v1")) == "paid"
    assert provider_cost_class(LLMSettings(provider="openai")) == "paid"
    assert provider_cost_class(LLMSettings(provider="")) == "paid"  # default is openai
    for local in ("ollama", "lmstudio", "vllm"):
        assert provider_cost_class(LLMSettings(provider=local)) == "local"


# --- T3: the rulepack stem-collision advisory --------------------------------
#
# Two installed packs may both ship `rulepacks/<stem>.yaml`; install writes both to the
# ONE shared discovery path, so only the last one survives on disk and its rules then
# grade every room on that system. The collision is invisible from the shared dir — it
# is only reconstructable from the installed manifests' `files:` inventories. Doctor
# reports it as an advisory (exit 0), and ONLY when the declared sha256s differ: a
# reinstall/upgrade of the same pack, or two packs shipping identical bytes, is benign.

_PULP_A = "names: [pulp]\ndefaults:\n  力量: 7\n"
_PULP_B = "names: [pulp]\ndefaults:\n  力量: 9\n"


def _pack_manifest(pack_id: str, version: str, stem: str) -> str:
    return (
        f"id: {pack_id}\n"
        f"version: {version}\n"
        f"name: {pack_id}\n"
        "description: A bundled rule system.\n"
        "authors: [ada]\n"
        "license: MIT\n"
        "engine: {}\n"
        "contents:\n"
        f"  rulepacks: [rulepacks/{stem}.yaml]\n"
    )


def _install_rulepack_pack(root, data_dir, *, pack_id: str, version: str, stem: str, yaml_text: str):
    """Build + install a rulepack-only pack into `data_dir` (the real build/install path,
    so the manifest's generated `files:` digests are the real ones)."""
    from core.pack import build_pack, install_pack

    source = root / f"src-{pack_id}-{version}"
    (source / "rulepacks").mkdir(parents=True, exist_ok=True)
    (source / f"rulepacks/{stem}.yaml").write_text(yaml_text, encoding="utf-8")
    (source / "pack.yaml").write_text(_pack_manifest(pack_id, version, stem), encoding="utf-8")
    built = build_pack(source, root / f"{pack_id}-{version}.lwpack")
    return install_pack(
        built.path,
        packs_dir=data_dir / "packs",
        skills_dir=data_dir / "skills",
        rulepacks_dir=data_dir / "rulepacks",
        presets_dir=data_dir / "presets",
        current_protocol="9.9",
        current_server="9.9.9",
    )


def _installed_rulepack_paths(data_dir) -> dict[str, list[str]]:
    """POSITIVE CONTROL for the silent cases: what each installed home actually declares,
    read back from disk — proof the fixture really is a same-stem arrangement and the
    silence is the hash rule, not a failed install."""
    from core.pack import MANIFEST_NAME, parse_manifest_text

    declared: dict[str, list[str]] = {}
    for home in sorted((data_dir / "packs").iterdir()):
        manifest = parse_manifest_text((home / MANIFEST_NAME).read_text(encoding="utf-8"), expect_trust=True)
        declared[home.name] = list(manifest.contents["rulepacks"])
    return declared


def _doctor_for_data_dir(capsys, data_dir, locale: str = "en") -> str:
    settings = Settings(locale=locale, data_dir=str(data_dir))
    return _doctor_stderr(capsys, settings)


def test_doctor_warns_when_two_packs_ship_the_same_rulepack_stem(tmp_path, capsys):
    data_dir = tmp_path / "data"
    _install_rulepack_pack(tmp_path, data_dir, pack_id="alpha", version="1.0.0", stem="pulp", yaml_text=_PULP_A)
    _install_rulepack_pack(tmp_path, data_dir, pack_id="beta", version="1.0.0", stem="pulp", yaml_text=_PULP_B)

    output = _doctor_for_data_dir(capsys, data_dir)

    assert "rulepacks/pulp.yaml" in output, output
    assert "alpha" in output and "beta" in output, output


def test_the_stem_collision_warning_is_localized(tmp_path, capsys):
    data_dir = tmp_path / "data"
    _install_rulepack_pack(tmp_path, data_dir, pack_id="alpha", version="1.0.0", stem="pulp", yaml_text=_PULP_A)
    _install_rulepack_pack(tmp_path, data_dir, pack_id="beta", version="1.0.0", stem="pulp", yaml_text=_PULP_B)

    output = _doctor_for_data_dir(capsys, data_dir, locale="zh")

    assert "rulepacks/pulp.yaml" in output, output
    assert "内容不同" in output, output


def test_doctor_stays_silent_when_two_packs_ship_identical_rulepack_bytes(tmp_path, capsys):
    # Same stem, IDENTICAL content: whichever install wins, the file on disk is the same
    # one both packs shipped. Nothing to tell the operator.
    data_dir = tmp_path / "data"
    _install_rulepack_pack(tmp_path, data_dir, pack_id="alpha", version="1.0.0", stem="pulp", yaml_text=_PULP_A)
    _install_rulepack_pack(tmp_path, data_dir, pack_id="beta", version="1.0.0", stem="pulp", yaml_text=_PULP_A)

    assert _installed_rulepack_paths(data_dir) == {
        "alpha@1.0.0": ["rulepacks/pulp.yaml"],
        "beta@1.0.0": ["rulepacks/pulp.yaml"],
    }
    output = _doctor_for_data_dir(capsys, data_dir)

    assert "rulepacks/pulp.yaml" not in output, output
    assert "Data dir" in output, output  # the doctor did run against this data dir


def test_doctor_stays_silent_after_reinstalling_or_upgrading_the_same_pack(tmp_path, capsys):
    # THE false positive that kept this out of cfee2e4: one pack, installed twice, its
    # rulepack legitimately rewritten between versions. Both homes stay on disk, but a
    # pack replacing its own rulepack is not a collision.
    data_dir = tmp_path / "data"
    _install_rulepack_pack(tmp_path, data_dir, pack_id="alpha", version="1.0.0", stem="pulp", yaml_text=_PULP_A)
    _install_rulepack_pack(tmp_path, data_dir, pack_id="alpha", version="1.0.0", stem="pulp", yaml_text=_PULP_A)
    _install_rulepack_pack(tmp_path, data_dir, pack_id="alpha", version="1.1.0", stem="pulp", yaml_text=_PULP_B)

    assert _installed_rulepack_paths(data_dir) == {
        "alpha@1.0.0": ["rulepacks/pulp.yaml"],
        "alpha@1.1.0": ["rulepacks/pulp.yaml"],
    }
    output = _doctor_for_data_dir(capsys, data_dir)

    assert "rulepacks/pulp.yaml" not in output, output
    assert "Data dir" in output, output


def test_a_single_installed_pack_leaves_the_doctor_unchanged(tmp_path, capsys):
    data_dir = tmp_path / "data"
    _install_rulepack_pack(tmp_path, data_dir, pack_id="alpha", version="1.0.0", stem="pulp", yaml_text=_PULP_A)

    assert _installed_rulepack_paths(data_dir) == {"alpha@1.0.0": ["rulepacks/pulp.yaml"]}
    output = _doctor_for_data_dir(capsys, data_dir)

    assert "rulepacks/pulp.yaml" not in output, output
    assert "OK" in output, output


def test_stem_collisions_are_hash_aware_over_installed_manifests():
    """The pure half, straight from the manifests: same stem + different digests across
    two pack ids collides; equal digests do not."""
    from core.pack import PackFile, PackManifest, rulepack_stem_collisions

    def _manifest(pack_id: str, digest: str) -> PackManifest:
        return PackManifest(
            id=pack_id,
            version="1.0.0",
            name={"en": pack_id},
            description={"en": pack_id},
            authors=(),
            license="MIT",
            engine={},
            contents={"rulepacks": ("rulepacks/pulp.yaml",)},
            assets=(),
            files=(PackFile(path="rulepacks/pulp.yaml", sha256=digest, size=1),),
        )

    differing = rulepack_stem_collisions({"alpha": _manifest("alpha", "a" * 64), "beta": _manifest("beta", "b" * 64)})
    assert [(item.stem, item.pack_ids) for item in differing] == [("pulp", ("alpha", "beta"))]

    same = rulepack_stem_collisions({"alpha": _manifest("alpha", "a" * 64), "beta": _manifest("beta", "a" * 64)})
    assert same == []


