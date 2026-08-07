"""Locale-catalog hygiene: a key deletion must be symmetric across locales.

Deliberately NOT here: a general "every catalog key is referenced" lint. Most
unreferenced-looking keys are built dynamically (``i18n.t(f"tui.error.{code}")``,
``t(f"commands.reset.scope.{scope}")``, ``t(f"modvars.visibility.{visibility}")``,
…), so such a lint can only run off a hand-maintained allowlist of dozens of
legitimately-dynamic keys — over-strict, and it would fire on error paths that
only execute when something is already going wrong.

What IS mechanically checkable is the invariant that iron rule 4 states and the
loader silently hides: `infra.i18n` falls back ``locale -> en -> the key itself``
(infra/i18n.py:_lookup), so a key pruned from ``zh`` alone keeps rendering — in
English — with no error anywhere. Same for a catalog file emptied instead of
removed. Both are exactly how a cleanup pass goes wrong.
"""

from __future__ import annotations

import json

from infra.i18n import _REPO_ROOT

LOCALES_DIR = _REPO_ROOT / "locales"


def catalog_key_sets(locales_dir) -> dict[str, dict[str, set[str]]]:
    """``{locale: {catalog_file_name: {key, ...}}}`` for every locale directory."""
    catalogs: dict[str, dict[str, set[str]]] = {}
    for locale_dir in sorted(p for p in locales_dir.iterdir() if p.is_dir()):
        files: dict[str, set[str]] = {}
        for json_file in sorted(locale_dir.glob("*.json")):
            data = json.loads(json_file.read_text(encoding="utf-8"))
            files[json_file.name] = set(data)
        if files:
            catalogs[locale_dir.name] = files
    return catalogs


def parity_violations(catalogs: dict[str, dict[str, set[str]]]) -> list[str]:
    """Human-readable reasons the locales are not key-for-key identical (empty == clean)."""
    reasons: list[str] = []
    if len(catalogs) < 2:
        return ["fewer than two locales found"]
    reference, ref_files = next(iter(catalogs.items()))
    for locale, files in catalogs.items():
        for name, keys in files.items():
            if not keys:
                reasons.append(f"{locale}/{name}: empty catalog file — delete it instead")
        if locale == reference:
            continue
        missing_files = sorted(set(ref_files) - set(files))
        extra_files = sorted(set(files) - set(ref_files))
        for name in missing_files:
            reasons.append(f"{locale}: missing catalog file {name} (present in {reference})")
        for name in extra_files:
            reasons.append(f"{locale}: extra catalog file {name} (absent from {reference})")
        for name in sorted(set(ref_files) & set(files)):
            for key in sorted(ref_files[name] - files[name]):
                reasons.append(f"{locale}/{name}: missing key {key}")
            for key in sorted(files[name] - ref_files[name]):
                reasons.append(f"{locale}/{name}: key {key} not in {reference}")
    return reasons


def test_parity_checker_positive_and_negative_controls():
    clean = {"en": {"a.json": {"a.one", "a.two"}}, "zh": {"a.json": {"a.one", "a.two"}}}
    assert parity_violations(clean) == []

    one_sided_key_deletion = {"en": {"a.json": {"a.one", "a.two"}}, "zh": {"a.json": {"a.one"}}}
    assert parity_violations(one_sided_key_deletion) == ["zh/a.json: missing key a.two"]

    one_sided_file_deletion = {"en": {"a.json": {"a.one"}, "b.json": {"b.one"}}, "zh": {"a.json": {"a.one"}}}
    assert parity_violations(one_sided_file_deletion) == ["zh: missing catalog file b.json (present in en)"]

    emptied_file = {"en": {"a.json": set()}, "zh": {"a.json": set()}}
    assert parity_violations(emptied_file) == [
        "en/a.json: empty catalog file — delete it instead",
        "zh/a.json: empty catalog file — delete it instead",
    ]


def test_real_locale_tree_is_key_for_key_symmetric():
    catalogs = catalog_key_sets(LOCALES_DIR)
    # Guard against the checker passing over nothing at all.
    assert set(catalogs) >= {"en", "zh"}
    assert len(catalogs["en"]) >= 20

    assert parity_violations(catalogs) == []
