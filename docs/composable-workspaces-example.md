# Example: dashboard, desktop companion and ESP32

Assume these **existing** independent workspace roots, each created earlier with
`ws init`, each retaining its own repositories, instructions, skills and profiles:

```text
~/projects/
  dashboard/       # repositories: web, perhaps other services
  companion/       # repositories: desktop (Rust / GPUI)
  esp32/           # repositories: firmware
```

Create a separate control workspace; it owns composition metadata and optional
architecture/contracts, never the member checkouts:

```sh
mkdir -p ~/projects/agent-control
cd ~/projects/agent-control
ws init . --name agent-control
ws compose create 'Agent Control System'
ws compose add dashboard ../dashboard --role 'Routes controller commands'
ws compose add companion ../companion --role 'Owns desktop activation' --access read-write
ws compose add esp32 ../esp32 --role 'Emits hardware button actions' --access read-write
ws compose list
ws compose inspect --json
ws compose validate --json
```

The commands require the new CLI build. `access` records intended dispatch scope;
it neither starts agents nor grants filesystem access. Explicit member `ws run`
commands continue using that member's existing permissions and profile policies.

Put shared architectural context in `agent-control/.workspace/context` using the
existing conventions. An optional integration repository can own a versioned
button-command schema and compatibility tests. It should contain only its own
contracts/tests, not copies of dashboard, Rust or firmware source.

For “open a Codex Desktop session when a hardware button is pressed”, use the
roles and member repository names in `compose inspect` to identify ownership:
firmware emits a command, dashboard routes it, companion activates the session,
and the integration owner defines the contract. Phase B inspects this structure;
it does not automatically load instructions, start parent tasks or dispatch Runs.

Today, start independent bounded Runs from each member, with caller-owned Task
correlation in the existing `--intent` object:

```sh
cd ~/projects/esp32
ws run coder 'Emit the agreed button action' --repo firmware --no-integrate \
  --intent '{"lineage":{"task":"remote-focus"},"subtask":"emit","attempt":1}'
ws runs --json
# Review the actual Candidate and validation before ws integrate <candidate-id>.
```

Use that member's existing profile name instead of `coder` if different. This
command does not import composition context; pass the reviewed contract through
approved existing context conventions. The proposed C/D interfaces in the
[plan](composable-workspaces.md) will make that selection inspectable and link
coordinated results without forcing one working directory or shared Git history.

A second control workspace can reference the same dashboard with its same ID.
Members can also be compositions; nested identity cycles are rejected. Joining
does not modify any member file. Existing `ws repo`, `ws run`, `ws inspect` and
integration workflows continue independently.

If firmware is temporarily unavailable, inspection reports it unresolved and
validation exits nonzero. Existing available members still appear. If it moves:

```sh
cd ~/projects/agent-control
ws compose relocate esp32 ../hardware-controller
ws compose validate
```

The destination must have the original firmware workspace ID. To stop composing:

```sh
ws compose remove esp32
```

This edits only `agent-control/.workspace/composition.yaml`; it never deletes the
firmware workspace, repositories, skills, history, Runs or unresolved Candidates.
Commit only control-owned metadata/context to its own repository. Do not commit
local writer locks, temporary files, runtime databases or member checkouts.
