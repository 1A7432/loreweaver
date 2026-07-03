import type { InitiativeEntry, PartyMember } from "@loreweaver/protocol"

export interface PartyPanelProps {
  party: PartyMember[]
  initiative: InitiativeEntry[]
}

function initiativeValue(member: PartyMember, initiative: InitiativeEntry[]): number | undefined {
  return member.initiative ?? initiative.find((entry) => entry.name === member.name)?.value
}

export function PartyPanel({ party, initiative }: PartyPanelProps) {
  return (
    <section className="panel party-panel">
      <div className="panel-title">PARTY</div>
      {party.length === 0 ? (
        <p className="muted">No roster</p>
      ) : (
        <ul className="party-list">
          {party.map((member) => {
            const init = initiativeValue(member, initiative)
            return (
              <li key={member.name} className={`party-member ${member.online ? "online" : "offline"}`}>
                <span className="active-mark">{member.active ? "▶" : ""}</span>
                <span className="dot">{member.online ? "●" : "○"}</span>
                <span className="party-name">{member.name}</span>
                {typeof init === "number" ? <span className="party-init">{init}</span> : null}
              </li>
            )
          })}
        </ul>
      )}
      {initiative.length > 0 ? (
        <>
          <div className="init-title">INITIATIVE</div>
          <ul className="init-list">
            {initiative.map((entry) => (
              <li key={`${entry.name}-${entry.value}`} className={`init-entry${entry.current ? " current" : ""}`}>
                {entry.current ? "▶ " : "  "}
                {entry.name} {entry.value}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}
