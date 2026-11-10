export function setSandboxMode(session, mode) { session.events.push({ type: 'sandbox/mode', data: { mode } }) }
