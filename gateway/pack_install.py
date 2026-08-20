"""Installing a `.lwpack` into THIS server's data dir, and the trust card that describes it.

Two callers, one implementation: the operator's `python -m app --install <ref>` and the
keeper's in-room `.pack install <ref>`. The CLI owns the interactive confirmation and the
printing; everything below the confirmation — which directories a pack lands in, which
engine versions it is checked against, and clearing the discovery caches afterwards — is
the same work, and a second copy of it is how the two doors drift apart.

`trust_card_lines` renders the disclosure card as LINES rather than printing them, so the
same card reaches a terminal (stderr) and a room (one reply). Disclosure, not a gate —
the same trust stance as full EJS: the operator's box, the operator's call.
"""

from __future__ import annotations

from pathlib import Path

import core.pack as core_pack
import core.rulepacks as core_rulepacks
import core.skills as core_skills
from infra.file_permissions import ensure_private_directory
from infra.i18n import I18n


def install_pack_here(data_dir: Path | str, pack_path: Path | str) -> core_pack.InstallReport:
    """Land a verified `.lwpack` in ``data_dir`` and make its contents discoverable.

    Blocking (zip verification + extraction): call it off the event loop. Raises
    `core.pack.PackError` exactly as `core.pack.install_pack` does, which already
    guarantees a failed install changed nothing.
    """
    from infra.version import resolve_version
    from net.session import PROTOCOL_VERSION  # gateway->net seam; module-level would cycle

    data_dir = Path(data_dir)
    ensure_private_directory(data_dir)
    report = core_pack.install_pack(
        Path(pack_path),
        packs_dir=data_dir / "packs",
        skills_dir=data_dir / "skills",
        rulepacks_dir=data_dir / "rulepacks",
        presets_dir=data_dir / "presets",
        current_protocol=PROTOCOL_VERSION,
        current_server=resolve_version(),
        builtin_skill_ids=[entry.parent.name for entry in core_skills._SKILL_DIR.glob("*/SKILL.md")],
        builtin_rulepack_ids=[entry.stem for entry in core_rulepacks._RULEPACK_DIR.glob("*.yaml")],
    )
    # A just-installed skill/rulepack must be discoverable without a restart.
    core_skills.reload_skills()
    core_rulepacks.reload_rulepacks()
    return report


def trust_card_lines(
    i18n: I18n, manifest: core_pack.PackManifest, locale: str, *, instructional: bool = True
) -> list[str]:
    """The disclosure card for one pack: what is inside, notably whether it ships
    sandboxed hooks/EJS/rules code and how heavy its media is. Empty for a manifest with
    no trust block (a source tree, which has not been built yet).

    ``instructional`` is which DOOR is rendering. The terminal's `--install` shows the card
    BEFORE anything happens, so telling the operator which command loads a world card is the
    only place that fact is available. The room's `.pack install` shows it AFTER an install
    that already imported the unique world card itself — and when several ship, the reply
    names each `.import` fork on its own line — so the card repeating the instruction there
    is at best noise and at worst a contradiction. Pass ``instructional=False`` for that door
    and the world-card line states the count alone.
    """
    trust = manifest.trust
    if trust is None:
        return []
    lines = [
        i18n.t("pack.card.header", name=manifest.display_name(locale), id=manifest.id, version=manifest.version)
    ]
    description = manifest.description.get(locale) or manifest.description.get("en") or ""
    if description:
        lines.append(i18n.t("pack.card.description", description=description))
    lines.append(
        i18n.t("pack.card.provenance", authors=", ".join(manifest.authors) or "-", license=manifest.license)
    )
    lines.append(
        i18n.t(
            "pack.card.trust",
            skills=trust.skills,
            rulepacks=trust.rulepacks,
            cards=trust.cards,
            lorebooks=trust.lorebooks,
            panels=trust.panels,
            assets=trust.assets,
            asset_mb=f"{trust.asset_bytes / (1024 * 1024):.1f}",
            hooks=i18n.t("pack.flag.yes") if trust.has_hooks else i18n.t("pack.flag.no"),
            ejs=i18n.t("pack.flag.yes") if trust.has_ejs else i18n.t("pack.flag.no"),
            rules_script=i18n.t("pack.flag.yes") if trust.has_rules_script else i18n.t("pack.flag.no"),
        )
    )
    if trust.has_rules_script:
        # The flag alone undersells it: hooks decorate a turn, but a rules script
        # IS the check ladder — it decides whether the operator's players succeed.
        lines.append(i18n.t("pack.card.rules_script"))
    if trust.world_cards:
        world_key = "pack.card.world_cards" if instructional else "pack.card.world_cards_plain"
        lines.append(i18n.t(world_key, count=trust.world_cards))
    if trust.presentation:
        # Disclosure, not marketing: an operator must see BEFORE install whether a
        # module's Stage Director may spend their image-provider budget.
        lines.append(
            i18n.t(
                "pack.card.presentation",
                subjects=trust.presentation,
                imagegen=i18n.t(
                    "pack.card.presentation.imagegen" if trust.imagegen else "pack.card.presentation.pack_only"
                ),
            )
        )
    if trust.presets:
        lines.append(i18n.t("pack.card.presets", count=trust.presets))
    if trust.prep_scripts:
        # Code, so it gets a loud line like hooks — but unlike hooks it never
        # auto-runs: the keeper invokes it by reference and previews the whole plan.
        lines.append(i18n.t("pack.card.prep", count=trust.prep_scripts))
    return lines
