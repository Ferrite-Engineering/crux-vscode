// Runs crux_cxp's two containment rules — `isCxpLoopbackHost` and
// `CxpWorkspaceStore.isValidDesignId` — over a corpus and prints the answers,
// so the TypeScript ports in `packages/host-core/src/cxp/loopback.ts` and
// `workspace-store.ts` can be required to agree with them case for case.
//
// This is the other half of the "containment rules" cross-run in
// `packages/host-core/test/cxp/dart-interop.test.ts`. Like the harnesses
// beside it, it imports the unmodified reference implementation from the
// sibling `crux-shared` checkout and restates nothing.
//
// Usage (the test does this for you):
//
//   dart run \
//     --packages=<crux-shared>/.dart_tool/package_config.json \
//     tool/dart-conformance/cxp_rules.dart < corpus.json
//
// stdin  — {"hosts": [...], "workspaceDirectory": "...", "designIds": [...]}
// stdout — {"hosts": [bool, ...], "designIds": [bool, ...]}, in input order
//          (arrays rather than maps, so a repeated input cannot collide).

import 'dart:convert';
import 'dart:io';

import 'package:crux_cxp/crux_cxp.dart';

Future<void> main() async {
  final input = jsonDecode(
    await stdin.transform(utf8.decoder).join(),
  ) as Map<String, Object?>;
  final hosts = (input['hosts']! as List<Object?>).cast<String>();
  final designIds = (input['designIds']! as List<Object?>).cast<String>();
  final store = CxpWorkspaceStore(
    workspaceDirectory: input['workspaceDirectory']! as String,
  );
  stdout.write(
    jsonEncode(<String, Object?>{
      'hosts': [for (final host in hosts) isCxpLoopbackHost(host)],
      'designIds': [for (final id in designIds) store.isValidDesignId(id)],
    }),
  );
}
