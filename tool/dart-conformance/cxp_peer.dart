// Runs a REAL crux_cxp peer — `LocalCxpServer`, `CxpManifestWriter`,
// `CxpDiscovery` and `CxpPeerConnector`, all with their production defaults —
// over a manifest directory the caller chooses, so the TypeScript transport in
// `packages/host-core/src/cxp/` can be driven against the implementation it
// has to interoperate with rather than against itself.
//
// This is the other half of `packages/host-core/test/cxp/dart-interop.test.ts`.
// Like `design_id_tokens.dart` beside it, it imports
// `package:crux_cxp/crux_cxp.dart` — the unmodified reference implementation
// in the sibling `crux-shared` checkout — and restates nothing, because a
// harness that re-implemented the handshake would agree with itself forever.
//
// Usage (the test does this for you):
//
//   dart run \
//     --packages=<crux-shared>/.dart_tool/package_config.json \
//     tool/dart-conformance/cxp_peer.dart <manifest-directory> \
//     [<workspace-directory>]
//
// What the peer does:
//
// - binds loopback on an OS-assigned port, requiring its token (the
//   default), and publishes its manifest — token included — into
//   <manifest-directory>;
// - discovers and dials every other manifest there, presenting each one's
//   token, exactly as a desktop product does;
// - answers every `request_highlight` with an honored ack;
// - answers every `request_open_artifact` by resolving it the way a desktop
//   receiver does, with crux_cxp's own pieces: the record its
//   `CxpWorkspaceStore` finds in <workspace-directory> for the design id and
//   artifact kind, else the request's `path` hint, judged by the floor rule
//   (`const CxpPathContainment()`). It reports what it found and acks
//   honored when there is a path the floor admits. Which kinds a product
//   opens, and what it does with the file, is the product's to decide, so
//   the test asserts that on the facts reported here. Without a
//   <workspace-directory> no record is ever found.
//
// stdout — one JSON object per line:
//   {"event":"ready","peer_id":…,"port":…}
//   {"event":"dialled","peer_id":…}               its outbound handshake completed
//   {"event":"dial_failure","peer_id":…,"code":…,"reason":…,"error":…}
//   {"event":"inbound","kind":…,"from":…}
//   {"event":"open_artifact","design_id":…,"artifact_kind":…,"hint":…,
//    "resolved":…,"floor_refusal":…}              after an inbound request_open_artifact
// The token is never printed: the test reads it from the manifest, as a
// real peer would.
//
// stdin — closing it shuts the peer down cleanly (manifest removed). A
// three-minute self-destruct stops an orphaned harness from outliving a
// crashed test run.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crux_cxp/crux_cxp.dart';

void emit(Map<String, Object?> event) => stdout.writeln(jsonEncode(event));

Future<void> main(List<String> args) async {
  if (args.isEmpty || args.length > 2) {
    stderr.writeln(
      'usage: cxp_peer.dart <manifest-directory> [<workspace-directory>]',
    );
    exit(64);
  }
  final manifestDirectory = args.first;
  final workspace = args.length == 2
      ? CxpWorkspaceStore(
          workspaceDirectory: args[1],
          containment: const CxpPathContainment(),
        )
      : null;
  final identity = PeerIdentity(
    peerId: 'wavecrux-$pid-${DateTime.now().millisecondsSinceEpoch}',
    productName: 'WaveCrux',
    productVersion: '0.0.0-interop',
    capabilities: const <String>{'request_highlight'},
  );

  final server = LocalCxpServer(selfIdentity: identity);
  await server.start();
  server.inbound.listen((inbound) {
    emit(<String, Object?>{
      'event': 'inbound',
      'kind': inbound.message.kind,
      'from': inbound.from.peerId,
    });
    final message = inbound.message;
    if (message is RequestHighlight) {
      server.sendTo(
        inbound.from.peerId,
        RequestHighlightAck(
          inReplyTo: inbound.envelope.messageId,
          honored: true,
        ),
      );
    } else if (message is RequestOpenArtifact) {
      final resolved = workspace
          ?.resolveArtifact(message.designId, message.artifactKind)
          ?.path;
      final candidate = resolved ?? message.path;
      final refusal = candidate == null
          ? null
          : const CxpPathContainment().refuse(candidate);
      emit(<String, Object?>{
        'event': 'open_artifact',
        'design_id': message.designId,
        'artifact_kind': message.artifactKind,
        'hint': message.path,
        'resolved': resolved,
        'floor_refusal': refusal,
      });
      server.sendTo(
        inbound.from.peerId,
        RequestOpenArtifactAck(
          inReplyTo: inbound.envelope.messageId,
          honored: candidate != null && refusal == null,
          reason: candidate == null ? 'nothing recorded and no hint' : refusal,
        ),
      );
    }
  });

  final writer = CxpManifestWriter(
    manifestDirectory: manifestDirectory,
    heartbeatInterval: null,
  );
  await writer.write(
    identity: identity,
    host: '127.0.0.1',
    port: server.boundPort!,
  );

  final discovery = CxpDiscovery(
    manifestDirectory: manifestDirectory,
    selfPeerId: identity.peerId,
    scanInterval: const Duration(milliseconds: 100),
  );
  final connector = CxpPeerConnector(
    selfIdentity: identity,
    discovery: discovery,
    server: server,
    retryInterval: const Duration(milliseconds: 100),
    maxRetryBackoffTicks: 1,
  );
  connector.dialFailures.listen((failure) {
    final error = failure.error;
    emit(<String, Object?>{
      'event': 'dial_failure',
      'peer_id': failure.peerId,
      'code': error is CxpHandshakeException ? error.code : null,
      'reason': error is CxpDialRefusedException ? error.reason : null,
      'error': error.runtimeType.toString(),
    });
  });
  await discovery.start();
  connector.start();

  // The connector has no connection stream; poll its link set and report
  // each completed outbound handshake once.
  final dialled = <String>{};
  final poll = Timer.periodic(const Duration(milliseconds: 25), (_) {
    for (final peer in connector.connectedPeers) {
      if (dialled.add(peer.peerId)) {
        emit(<String, Object?>{'event': 'dialled', 'peer_id': peer.peerId});
      }
    }
  });

  emit(<String, Object?>{
    'event': 'ready',
    'peer_id': identity.peerId,
    'port': server.boundPort,
  });

  Future<void> shutdown(int code) async {
    poll.cancel();
    await writer.remove();
    await connector.dispose();
    await discovery.stop();
    await server.stop();
    await stdout.flush();
    exit(code);
  }

  final selfDestruct = Timer(const Duration(minutes: 3), () => shutdown(2));
  stdin.listen(
    (_) {},
    onDone: () {
      selfDestruct.cancel();
      unawaited(shutdown(0));
    },
  );
}
