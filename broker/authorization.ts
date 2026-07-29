import { type AuthorizationDecision, type PolicyAction, type PolicyPrincipal, type PolicyState } from "@dataforxyz/agent-intercom-core";
import {
  authorizeFeatureAware,
  type BossControlKind,
  type BossPolicyAction,
  type FeatureAwareAuthorizationDecision,
  type FeatureAwarePolicyState,
} from "@dataforxyz/agent-intercom-core/boss";
import type { SessionInfo } from "../types.ts";
import { parseBossSessionMetadata } from "./boss-contracts.ts";

export type SessionPolicyAction = PolicyAction | BossPolicyAction;
export type SessionAuthorizationDecision = AuthorizationDecision | FeatureAwareAuthorizationDecision;

export interface SessionAuthorizationContext {
  controlKind?: BossControlKind;
  correlated?: boolean;
}

export function policyPrincipalForSession(session: SessionInfo): PolicyPrincipal {
  if (session.boss !== undefined) {
    throw new Error(`Boss session ${session.id} cannot cross the frozen legacy policy boundary`);
  }
  if (session.origin === "remote") {
    if (!session.parentSessionId || !session.rootSessionId || !session.generation) {
      throw new Error(`Remote session ${session.id} is missing broker-owned policy metadata`);
    }
    return {
      id: session.id,
      kind: "remote",
      state: "active",
      generation: session.generation,
      policy: "remote-tree",
      parentSessionId: session.parentSessionId,
      rootSessionId: session.rootSessionId,
    };
  }
  return {
    id: session.id,
    kind: "local",
    state: "active",
    generation: 1,
    policy: "local-public",
    rootSessionId: session.id,
  };
}

export function policyStateForSessions(sessions: Iterable<SessionInfo>): PolicyState {
  const principals: Record<string, PolicyPrincipal> = {};
  for (const session of sessions) principals[session.id] = policyPrincipalForSession(session);
  return { principals };
}

export function featureAwarePolicyStateForSessions(sessions: Iterable<SessionInfo>): FeatureAwarePolicyState {
  const legacy: PolicyState = { principals: {} };
  const boss: FeatureAwarePolicyState["boss"] = { principals: {} };
  const registrations: FeatureAwarePolicyState["registrations"] = {};

  for (const session of sessions) {
    if (session.boss === undefined) {
      const principal = policyPrincipalForSession(session);
      legacy.principals[session.id] = principal;
      registrations[session.id] = {
        principalId: session.id,
        principalClass: "ordinary",
        state: "active",
      };
      continue;
    }

    const metadata = parseBossSessionMetadata(session.boss, session.id);
    boss.principals[session.id] = metadata.principal;
    registrations[session.id] = {
      principalId: session.id,
      principalClass: "boss-bound",
      state: "active",
      bossRunId: metadata.binding.bossRunId,
      participantId: metadata.binding.participantId,
      bindingEpoch: metadata.binding.bindingEpoch,
      featureContract: metadata.featureContract,
      policySemanticsHash: metadata.policySemanticsHash,
      capabilityDigest: metadata.capabilityDigest,
      brokerIdentityVerified: metadata.brokerIdentityVerified,
    };
  }

  return { legacy, boss, registrations };
}

export function authorizeSessionAction(
  sessions: Iterable<SessionInfo>,
  actorId: string,
  action: SessionPolicyAction,
  targetId: string,
  context: SessionAuthorizationContext = {},
): SessionAuthorizationDecision {
  const state = featureAwarePolicyStateForSessions(sessions);
  const actor = state.registrations[actorId];
  const target = state.registrations[targetId];
  return authorizeFeatureAware(state, {
    actorId,
    targetId,
    action,
    ...(actor?.principalClass === "ordinary" && target?.principalClass === "ordinary"
      ? {
          legacyContext: {
            actorGeneration: state.legacy.principals[actorId]?.generation,
            targetGeneration: state.legacy.principals[targetId]?.generation,
          },
        }
      : action === "control"
        ? {
            bossContext: {
              controlKind: context.controlKind,
              correlated: context.correlated,
            },
          }
        : {}),
  });
}

export function visibleSessions(sessions: Iterable<SessionInfo>, actorId: string): SessionInfo[] {
  const values = Array.from(sessions);
  return values.filter((target) => authorizeSessionAction(values, actorId, "discover", target.id).allowed);
}
