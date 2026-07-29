import assert from "node:assert/strict";
import test from "node:test";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_CONTROL_ENVELOPE_VERSION,
  BOSS_CONTROL_TYPES,
  BOSS_PARTICIPANT_BINDING_VERSION,
  BOSS_PARTICIPANT_CREDENTIAL_VERSION,
  BOSS_POLICY_PRINCIPAL_VERSION,
  BOSS_POLICY_SEMANTICS_HASH,
  BOSS_RUN_FEATURE,
  BOSS_RUN_FEATURE_CONTRACT,
  BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH,
  BROKER_FEATURE_ATTESTATION_VERSION,
  INTERCOM_BASE_PROTOCOL_VERSION,
  WORKER_IDENTITY_VERSION,
  brokerFeatureSetHash,
  type BossParticipantRole,
  type BossPrivatePrincipal,
} from "@dataforxyz/agent-intercom-core/boss";
import { brokerGeneration, participantBindingEpoch, workerGeneration } from "@dataforxyz/agent-intercom-core/canonical";
import type { BossSessionMetadata, SessionInfo } from "../types.ts";
import { authorizeSessionAction, visibleSessions } from "./authorization.ts";
import {
  BOSS_ADVERTISEMENT_ENABLED,
  BOSS_CONTROL_KIND_BY_TYPE,
  assertBossRegistrationEcho,
  assertCompatibleBossAdvertisement,
  assertCompatibleOrdinaryAdvertisement,
  assertBossControlSender,
  brokerCapabilityAdvertisement,
  bossControlDispatchDenial,
  parseCorrelatedBossControl,
  parseBossRegistrationRequest,
  parseBossSessionMetadata,
} from "./boss-contracts.ts";

function bossSession(
  id: string,
  role: BossParticipantRole,
  bossRunId = "boss-run-a",
  principalExtra: Partial<BossPrivatePrincipal> = {},
): SessionInfo {
  const participantId = `${id}-participant`;
  const bindingEpoch = participantBindingEpoch(1);
  const principal = {
    version: BOSS_POLICY_PRINCIPAL_VERSION,
    principalId: id,
    principalClass: "boss-private",
    state: "active",
    bossRunId,
    participantId,
    role,
    bindingEpoch,
    ...(role === "manager" ? { assignedParticipantIds: [] } : {}),
    ...(role === "worker" || role === "scout" ? { assignedManagerParticipantId: "manager-participant" } : {}),
    ...(role === "council" ? { requestingPrincipalId: "boss-session" } : {}),
    ...principalExtra,
  } as BossPrivatePrincipal;
  const metadata: BossSessionMetadata = {
    binding: {
      version: BOSS_PARTICIPANT_BINDING_VERSION,
      bossRunId,
      participantId,
      role,
      communicationProfile: role,
      bindingEpoch,
      sessionId: id,
      brokerGeneration: brokerGeneration(1),
      brokerBootInstance: "boot-a",
      state: "active",
      ...(role === "worker" || role === "scout" ? { assignedManagerParticipantId: "manager-participant" } : {}),
      authorityTransitionId: `transition-${id}`,
    },
    principal,
    liveWorker: {
      identity: {
        version: WORKER_IDENTITY_VERSION,
        workerId: id,
        workerIncarnationId: `inc-${id}`,
        workerGeneration: workerGeneration(2),
        bossRunId,
        participantId,
        bindingEpoch,
      },
      state: "working",
    },
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    policySemanticsHash: BOSS_POLICY_SEMANTICS_HASH,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
    brokerIdentityVerified: true,
  };
  return {
    id,
    name: id,
    cwd: "/repo",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    origin: "local",
    boss: metadata,
  };
}

function ordinary(id: string): SessionInfo {
  return { id, name: id, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1, origin: "local" };
}

function bossRegistrationRequest(role: BossParticipantRole = "adversary") {
  return {
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
    credential: {
      version: BOSS_PARTICIPANT_CREDENTIAL_VERSION,
      namespace: BOSS_RUN_FEATURE,
      credentialKind: "enrollment" as const,
      credentialId: "credential-a",
      credential: "secret",
      bossRunId: "boss-run-a",
      participantId: `${role}-participant`,
      role,
      communicationProfile: role,
      bindingEpoch: participantBindingEpoch(1),
      issuedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-28T00:05:00.000Z",
      nonce: "nonce-a",
    },
  };
}

function bossAdvertisement() {
  const feature = {
    version: BROKER_FEATURE_ATTESTATION_VERSION,
    feature: BOSS_RUN_FEATURE,
    featureVersion: BOSS_RUN_FEATURE_CONTRACT.version,
    semanticsHash: BOSS_RUN_FEATURE_CONTRACT.semanticsHash,
    controlEnvelopeVersion: BOSS_CONTROL_ENVELOPE_VERSION,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
  };
  return {
    baseProtocolVersion: INTERCOM_BASE_PROTOCOL_VERSION,
    features: [feature],
    protocolFeatureContractHash: BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH,
    featureSetHash: brokerFeatureSetHash([feature]),
    controlEnvelopeVersion: BOSS_CONTROL_ENVELOPE_VERSION,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
  };
}

test("Stage-B broker advertises exact base v3 while Boss remains dormant", () => {
  assert.equal(BOSS_ADVERTISEMENT_ENABLED, false);
  assert.deepEqual(brokerCapabilityAdvertisement(), { baseProtocolVersion: 3, features: [] });
});

test("Boss enrollment requests require Core's exact feature and capability binding", () => {
  const request = bossRegistrationRequest();
  assert.deepEqual(parseBossRegistrationRequest(request), request);
  assert.throws(() => parseBossRegistrationRequest({
    ...request,
    featureContract: { ...request.featureContract, baseProtocolVersion: 4 },
  }), /base protocol version/);
  assert.throws(() => parseBossRegistrationRequest({
    ...request,
    capabilityDigest: "0".repeat(64),
  }), /diverges/);
});

test("broker-authoritative Boss metadata is exact and session-bound", () => {
  const adversary = bossSession("adversary", "adversary");
  assert.deepEqual(parseBossSessionMetadata(adversary.boss, adversary.id), adversary.boss);
  assert.throws(() => parseBossSessionMetadata(adversary.boss, "substituted"), /registered session ID/);
  assert.throws(() => parseBossSessionMetadata({
    ...adversary.boss,
    principal: { ...adversary.boss!.principal, principalId: "substituted" },
  }, adversary.id), /principalId.*registered session ID/);
  assert.throws(() => parseBossSessionMetadata({ ...adversary.boss, unknown: true }, adversary.id), /not supported/);
  assert.throws(() => parseBossSessionMetadata({
    ...adversary.boss,
    liveWorker: {
      ...adversary.boss!.liveWorker,
      identity: { ...adversary.boss!.liveWorker.identity, workerIncarnationId: "" },
    },
  }, adversary.id), /workerIncarnationId/);
  assert.throws(() => parseBossSessionMetadata({
    ...adversary.boss,
    liveWorker: { ...adversary.boss!.liveWorker, state: "stopped" },
  }, adversary.id), /same live Boss worker identity/);
});

test("Boss negotiation requires the exact feature and broker-owned participant echo", () => {
  const request = bossRegistrationRequest();
  const adversary = bossSession("adversary", "adversary");
  assert.deepEqual(assertCompatibleBossAdvertisement(bossAdvertisement()), bossAdvertisement());
  assert.deepEqual(assertBossRegistrationEcho(request, adversary.boss, adversary.id), adversary.boss);
  assert.throws(() => assertCompatibleBossAdvertisement(brokerCapabilityAdvertisement()), /did not negotiate/);
  assert.throws(() => assertBossRegistrationEcho(request, bossSession("other", "adversary").boss, "other"), /does not match/);
});

test("capability parsing rejects proxy records and sparse feature arrays", () => {
  let trapCount = 0;
  const hostile = new Proxy({ baseProtocolVersion: 3, features: [] }, {
    getPrototypeOf() {
      trapCount += 1;
      throw new Error("proxy trap");
    },
  });
  assert.throws(() => assertCompatibleOrdinaryAdvertisement(hostile));
  assert.equal(trapCount, 0);
  const features: unknown[] = [];
  features.length = 1;
  assert.throws(() => assertCompatibleOrdinaryAdvertisement({ baseProtocolVersion: 3, features }), /dense/);

  const customFeatures: unknown[] = [];
  Object.setPrototypeOf(customFeatures, Object.create(Array.prototype));
  assert.throws(() => assertCompatibleOrdinaryAdvertisement({ baseProtocolVersion: 3, features: customFeatures }), /exact Array prototype/);
});

test("every authoritative nested Boss parser rejects Proxies before traps", () => {
  let trapCount = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() {
      trapCount += 1;
      throw new Error("proxy trap");
    },
    ownKeys() {
      trapCount += 1;
      throw new Error("proxy trap");
    },
  });
  const request = bossRegistrationRequest();
  assert.throws(() => parseBossRegistrationRequest({ ...request, credential: proxy }), /Proxy/);
  const session = bossSession("adversary", "adversary");
  assert.throws(() => parseBossSessionMetadata({ ...session.boss, principal: proxy }, session.id), /Proxy/);
  assert.throws(() => parseCorrelatedBossControl({
    type: "boss.worker.health",
    version: 1,
    messageId: "message-a",
    bossRunId: "boss-run-a",
    participantId: "participant-a",
    bindingEpoch: 1,
    idempotencyKey: "health-a",
    payload: proxy,
  }, "message-a"), /Proxy/);
  assert.equal(trapCount, 0);
});

test("every Core control type uses the shared exhaustive kind map", () => {
  assert.deepEqual(Object.keys(BOSS_CONTROL_KIND_BY_TYPE), [...BOSS_CONTROL_TYPES]);
  assert.equal(BOSS_CONTROL_KIND_BY_TYPE["boss.assignment.cancelled"], "lifecycle");
});

test("production Boss control dispatch denies exact IDs, names, and prefixes before ordinary resolution", () => {
  for (const target of ["adversary-session-id", "reviewer-name", "adversary-sess"]) {
    assert.deepEqual(bossControlDispatchDenial(target), {
      allowed: false,
      code: "CONTROL_DISPATCH_UNAVAILABLE",
      reason: "Typed Boss control dispatch is unavailable without authoritative correlation and durable dispatch",
    });
  }
});

test("a directionally valid control edge still denies without authoritative correlation", () => {
  const manager = bossSession("manager", "manager");
  const adversary = bossSession("adversary", "adversary");
  assert.equal(authorizeSessionAction([manager, adversary], adversary.id, "control", manager.id, {
    controlKind: "review_result",
    correlated: false,
  }).allowed, false);
});

test("feature-aware discovery isolates ordinary, cross-run, and unrelated Boss principals", () => {
  const manager = bossSession("manager", "manager");
  const adversary = bossSession("adversary", "adversary");
  const otherRun = bossSession("other-adversary", "adversary", "boss-run-b");
  const legacy = ordinary("legacy");
  const sessions = [manager, adversary, otherRun, legacy];

  assert.equal(authorizeSessionAction(sessions, manager.id, "send", adversary.id).allowed, true);
  assert.equal(authorizeSessionAction(sessions, manager.id, "send", otherRun.id).allowed, false);
  assert.equal(authorizeSessionAction(sessions, manager.id, "send", legacy.id).allowed, false);
  assert.equal(authorizeSessionAction(sessions, legacy.id, "send", manager.id).allowed, false);
  assert.deepEqual(visibleSessions(sessions, manager.id).map((session) => session.id).sort(), ["adversary", "manager"]);
});

test("typed control requires correlation and the Core directional kind", () => {
  const manager = bossSession("manager", "manager");
  const adversary = bossSession("adversary", "adversary");
  const sessions = [manager, adversary];
  assert.equal(authorizeSessionAction(sessions, adversary.id, "control", manager.id, {
    controlKind: "review_result",
    correlated: true,
  }).allowed, true);
  assert.equal(authorizeSessionAction(sessions, adversary.id, "control", manager.id, {
    controlKind: "review_result",
    correlated: false,
  }).allowed, false);
  assert.equal(authorizeSessionAction(sessions, adversary.id, "control", manager.id, {
    controlKind: "assignment_request",
    correlated: true,
  }).allowed, false);
});

test("typed control identity is correlated to message, run, participant, and epoch", () => {
  const adversary = bossSession("adversary", "adversary");
  const control = {
    type: "boss.review.submitted" as const,
    version: 1 as const,
    messageId: "message-a",
    bossRunId: adversary.boss!.binding.bossRunId,
    participantId: adversary.boss!.binding.participantId,
    bindingEpoch: adversary.boss!.binding.bindingEpoch,
    replyTo: "review-request-a",
    idempotencyKey: "review-a",
    payload: { reviewId: "review-a" },
  };
  assert.deepEqual(assertBossControlSender(adversary, control, "message-a"), control);
  assert.throws(() => assertBossControlSender(adversary, { ...control, bossRunId: "boss-run-b" }, "message-a"), /not bound/);
  assert.throws(() => assertBossControlSender(adversary, control, "message-b"), /transport message ID/);
});
