// Runs the REAL Dart `cxpDesignIdForPath` over a corpus of paths and prints
// the tokens as JSON, so the TypeScript port in
// `packages/host-core/src/cxp/design-id.ts` can be asserted byte-identical
// against the implementation it is a port of.
//
// This is the other half of `packages/host-core/test/cxp/
// design-id-conformance.test.ts`. It deliberately imports
// `package:crux_cxp/crux_cxp.dart` — the unmodified reference implementation
// in the sibling `crux-shared` checkout — rather than restating any part of
// the derivation, because a harness that re-implemented the thing under test
// would agree with itself forever.
//
// Usage (the test does this for you):
//
//   dart run \
//     --packages=<crux-shared>/.dart_tool/package_config.json \
//     tool/dart-conformance/design_id_tokens.dart < inputs.json
//
// stdin  — a JSON array of path strings.
// stdout — a JSON object mapping each input string to its 16-hex token.
//
// `--packages` points at the crux-shared workspace's existing package
// config, so this file needs no pubspec, no `pub get`, and — the constraint
// that mattered when it was written — no file added to the crux-shared repo.

import 'dart:convert';
import 'dart:io';

import 'package:crux_cxp/crux_cxp.dart';

void main() {
  final source = stdin.transform(utf8.decoder).join();
  source.then((text) {
    final inputs = (jsonDecode(text) as List<Object?>).cast<String>();
    final tokens = <String, String>{
      for (final input in inputs) input: cxpDesignIdForPath(input),
    };
    stdout.write(jsonEncode(tokens));
  });
}
