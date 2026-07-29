import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_POLICY_SEMANTICS_HASH,
  BOSS_RUN_FEATURE,
  BOSS_RUN_FEATURE_CONTRACT,
  INTERCOM_BASE_PROTOCOL_VERSION,
  evaluateBrokerCompatibility,
  parseBossControlEnvelope,
  parseBossParticipantBinding,
  parseBossParticipantCredentialEnvelope,
  parseBossPolicyPrincipal,
  parseBossRunFeatureContract,
  parseBrokerCapabilityAdvertisement,
  isTerminalParticipantState,
  parseParticipantState,
  parseWorkerIdentityV2,
  type BossControlEnvelope,
  type BossControlKind,
  type BossControlType,
  type BossPrivatePrincipal,
  type BrokerCapabilityAdvertisement,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  ContractValidationError,
  assertExactKeys,
  assertRecord,
  readHexDigest,
} from "@dataforxyz/agent-intercom-core/canonical";
import type {
  BossRegistrationRequest,
  BossSessionMetadata,
  SessionInfo,
} from "../types.ts";
import { assertPlainDataGraph } from "./validation.ts";

/**
 * Stage B deliberately does not advertise boss-run-v1. The protected provider,
 * signed identity, credential lifecycle, transition journal, and coordinated
 * health predicates must land before this can become true.
 */
export const BOSS_ADVERTISEMENT_ENABLED = false as const;

export function brokerCapabilityAdvertisement(): BrokerCapabilityAdvertisement {
  return parseBrokerCapabilityAdvertisement({
    baseProtocolVersion: INTERCOM_BASE_PROTOCOL_VERSION,
    features: [],
  });
}

export function assertCompatibleOrdinaryAdvertisement(value: unknown): BrokerCapabilityAdvertisement {
  assertPlainDataGraph(value, "$.capabilities");
  const advertisement = parseBrokerCapabilityAdvertisement(value);
  const decision = evaluateBrokerCompatibility({
    clientKind: "ordinary",
    supportedBaseProtocolVersions: [INTERCOM_BASE_PROTOCOL_VERSION],
  }, advertisement);
  if (!decision.compatible || decision.mode !== "ordinary") {
    throw new ContractValidationError("$.capabilities", "broker does not support exact base protocol v3");
  }
  return advertisement;
}

export function assertCompatibleBossAdvertisement(value: unknown): BrokerCapabilityAdvertisement {
  assertPlainDataGraph(value, "$.capabilities");
  const advertisement = parseBrokerCapabilityAdvertisement(value);
  if (
    advertisement.baseProtocolVersion !== INTERCOM_BASE_PROTOCOL_VERSION
    || !advertisement.features.some((feature) => feature.feature === BOSS_RUN_FEATURE)
  ) {
    throw new ContractValidationError("$.capabilities", "broker did not negotiate the exact required Boss feature");
  }
  return advertisement;
}

export function parseBossRegistrationRequest(value: unknown): BossRegistrationRequest {
  assertPlainDataGraph(value, "$.boss");
  assertRecord(value, "$.boss");
  assertExactKeys(value, ["featureContract", "capabilityDigest", "credential"], [], "$.boss");
  const featureContract = parseBossRunFeatureContract(value.featureContract);
  const capabilityDigest = readHexDigest(value.capabilityDigest, "$.boss.capabilityDigest");
  if (
    featureContract.feature !== BOSS_RUN_FEATURE_CONTRACT.feature
    || featureContract.version !== BOSS_RUN_FEATURE_CONTRACT.version
    || featureContract.baseProtocolVersion !== INTERCOM_BASE_PROTOCOL_VERSION
    || featureContract.semanticsHash !== BOSS_RUN_FEATURE_CONTRACT.semanticsHash
    || featureContract.controlEnvelopeVersion !== BOSS_RUN_FEATURE_CONTRACT.controlEnvelopeVersion
    || capabilityDigest !== BOSS_CAPABILITY_FEATURE_DIGEST
  ) {
    throw new ContractValidationError("$.boss", "Boss registration diverges from the canonical feature contract");
  }
  return {
    featureContract,
    capabilityDigest,
    credential: parseBossParticipantCredentialEnvelope(value.credential),
  };
}

export function parseBossSessionMetadata(value: unknown, sessionId?: string): BossSessionMetadata {
  assertPlainDataGraph(value, "$.boss");
  assertRecord(value, "$.boss");
  assertExactKeys(value, [
    "binding",
    "principal",
    "liveWorker",
    "featureContract",
    "policySemanticsHash",
    "capabilityDigest",
    "brokerIdentityVerified",
  ], [], "$.boss");
  const binding = parseBossParticipantBinding(value.binding);
  const parsedPrincipal = parseBossPolicyPrincipal(value.principal);
  if (parsedPrincipal.principalClass !== "boss-private") {
    throw new ContractValidationError("$.boss.principal", "must be a Boss-private principal");
  }
  const principal: BossPrivatePrincipal = parsedPrincipal;
  assertRecord(value.liveWorker, "$.boss.liveWorker");
  assertExactKeys(value.liveWorker, ["identity", "state"], [], "$.boss.liveWorker");
  const liveWorkerIdentity = parseWorkerIdentityV2(value.liveWorker.identity);
  const liveWorkerState = parseParticipantState(value.liveWorker.state, "$.boss.liveWorker.state");
  const featureContract = parseBossRunFeatureContract(value.featureContract);
  const policySemanticsHash = readHexDigest(value.policySemanticsHash, "$.boss.policySemanticsHash");
  const capabilityDigest = readHexDigest(value.capabilityDigest, "$.boss.capabilityDigest");
  if (value.brokerIdentityVerified !== true) {
    throw new ContractValidationError("$.boss.brokerIdentityVerified", "must be true for a live Boss session");
  }
  if (sessionId !== undefined && binding.sessionId !== sessionId) {
    throw new ContractValidationError("$.boss.binding.sessionId", "must match the registered session ID");
  }
  if (sessionId !== undefined && principal.principalId !== sessionId) {
    throw new ContractValidationError("$.boss.principal.principalId", "must match the registered session ID");
  }
  if (
    !("bossRunId" in liveWorkerIdentity)
    || (sessionId !== undefined && liveWorkerIdentity.workerId !== sessionId)
    || liveWorkerIdentity.bossRunId !== binding.bossRunId
    || liveWorkerIdentity.participantId !== binding.participantId
    || liveWorkerIdentity.bindingEpoch !== binding.bindingEpoch
    || isTerminalParticipantState(liveWorkerState)
  ) {
    throw new ContractValidationError(
      "$.boss.liveWorker",
      "must attest the same live Boss worker identity and binding as the registered session",
    );
  }
  if (
    binding.state !== "active"
    || principal.state !== "active"
    || binding.bossRunId !== principal.bossRunId
    || binding.participantId !== principal.participantId
    || binding.role !== principal.role
    || binding.bindingEpoch !== principal.bindingEpoch
    || binding.assignedManagerParticipantId !== principal.assignedManagerParticipantId
  ) {
    throw new ContractValidationError("$.boss", "binding and policy principal are not the same active participant");
  }
  if (
    featureContract.semanticsHash !== BOSS_RUN_FEATURE_CONTRACT.semanticsHash
    || policySemanticsHash !== BOSS_POLICY_SEMANTICS_HASH
    || capabilityDigest !== BOSS_CAPABILITY_FEATURE_DIGEST
  ) {
    throw new ContractValidationError("$.boss", "Boss session attestation diverges from Core");
  }
  return {
    binding,
    principal,
    liveWorker: { identity: liveWorkerIdentity, state: liveWorkerState },
    featureContract,
    policySemanticsHash,
    capabilityDigest,
    brokerIdentityVerified: true,
  };
}

export function assertBossRegistrationEcho(
  requestValue: unknown,
  metadataValue: unknown,
  sessionId: string,
): BossSessionMetadata {
  const request = parseBossRegistrationRequest(requestValue);
  const metadata = parseBossSessionMetadata(metadataValue, sessionId);
  const credential = request.credential;
  const binding = metadata.binding;
  if (
    credential.bossRunId !== binding.bossRunId
    || credential.participantId !== binding.participantId
    || credential.role !== binding.role
    || credential.communicationProfile !== binding.communicationProfile
    || credential.bindingEpoch !== binding.bindingEpoch
    || request.featureContract.feature !== metadata.featureContract.feature
    || request.featureContract.version !== metadata.featureContract.version
    || request.featureContract.baseProtocolVersion !== metadata.featureContract.baseProtocolVersion
    || request.featureContract.semanticsHash !== metadata.featureContract.semanticsHash
    || request.featureContract.controlEnvelopeVersion !== metadata.featureContract.controlEnvelopeVersion
    || request.capabilityDigest !== metadata.capabilityDigest
  ) {
    throw new ContractValidationError("$.boss", "broker-owned Boss registration echo does not match the requested participant binding");
  }
  return metadata;
}

export const BOSS_CONTROL_KIND_BY_TYPE = {
  "boss.assignment.created": "assignment_request",
  "boss.assignment.accepted": "assignment_response",
  "boss.assignment.checkpoint": "assignment_response",
  "boss.assignment.submitted": "assignment_response",
  "boss.assignment.rejected": "assignment_response",
  "boss.assignment.cancelled": "lifecycle",
  "boss.staffing.requested": "staffing",
  "boss.staffing.resolved": "staffing",
  "boss.review.requested": "review_request",
  "boss.review.submitted": "review_result",
  "boss.council.requested": "review_request",
  "boss.council.submitted": "review_result",
  "boss.proof.submitted": "proof",
  "boss.worker.health": "health",
  "boss.worker.blocked": "health",
  "boss.worker.failed": "health",
  "boss.worker.notice": "lifecycle",
  "boss.worker.notice_delivery_failed": "lifecycle",
  "boss.decision.required": "decision",
} as const satisfies Readonly<Record<BossControlType, BossControlKind>>;

export function bossControlKind(envelope: BossControlEnvelope): BossControlKind {
  return BOSS_CONTROL_KIND_BY_TYPE[envelope.type];
}

export interface BossControlDispatchDenial {
  allowed: false;
  code: "CONTROL_DISPATCH_UNAVAILABLE";
  reason: string;
}

/**
 * This adapter has no protected Controller dispatch/ACK authority. Keep the
 * production control surface closed for every target spelling; callers must
 * apply this gate before ordinary name/prefix resolution.
 */
export function bossControlDispatchDenial(_target: string): BossControlDispatchDenial {
  return {
    allowed: false,
    code: "CONTROL_DISPATCH_UNAVAILABLE",
    reason: "Typed Boss control dispatch is unavailable without authoritative correlation and durable dispatch",
  };
}

export function parseCorrelatedBossControl(value: unknown, messageId?: string): BossControlEnvelope {
  assertPlainDataGraph(value, "$.control");
  const envelope = parseBossControlEnvelope(value);
  if (messageId !== undefined && envelope.messageId !== messageId) {
    throw new ContractValidationError("$.control.messageId", "must match the transport message ID");
  }
  return envelope;
}

export function assertBossControlSender(session: SessionInfo, envelopeValue: unknown, messageId: string): BossControlEnvelope {
  const envelope = parseCorrelatedBossControl(envelopeValue, messageId);
  const metadata = session.boss === undefined ? undefined : parseBossSessionMetadata(session.boss, session.id);
  if (
    metadata === undefined
    || envelope.bossRunId !== metadata.binding.bossRunId
    || envelope.participantId !== metadata.binding.participantId
    || envelope.bindingEpoch !== metadata.binding.bindingEpoch
  ) {
    throw new ContractValidationError("$.control", "control identity is not bound to the sending session");
  }
  return envelope;
}
