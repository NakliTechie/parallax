export function setApprovalPolicy(session, policy) { session.events.push({ type: 'approval/policy', data: { policy } }) }
