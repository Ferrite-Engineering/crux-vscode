/**
 * Telemetry: the `isTelemetryEnabled` gate, the event catalog, envelope
 * construction, the Worker sender, and the webview relay.
 *
 * See docs/implementation-map.md §2 (`telemetry`) and §7.
 *
 * ### The shape of it
 *
 * One [TelemetryClient] per product extension. Each product's
 * `activate()` constructs one, calls [TelemetryClient.start], and:
 *
 * - calls `client.record(...)` at its own host-native call sites
 *   ([TELEMETRY_EVENTS] names the shared ones — activation, file-opened,
 *   the status panel click, desktop-peer transitions — a product's own
 *   `feature.used` call sites are its own to add);
 * - wires its webview's `onDidReceiveMessage`, if it has one, to
 *   `client.recordFromWebview(message)` for any message shaped like a
 *   telemetry event descriptor, so the Dart side never sends anything
 *   itself — see [TelemetryClient]'s docs for why that channel is safe.
 *
 * Nothing in this module ever imports the real `vscode` module except
 * [vscodeTelemetryGateHost] and [installation-id.ts]'s `globalState`
 * adapter usage at the extension's own call site — the gate and the
 * sender are both interfaces a test can fake, and
 * `test/telemetry/client.test.ts` never makes a real request.
 */
export {
  TELEMETRY_APP_VERSION_PATTERN,
  TELEMETRY_EVENT_NAME_PATTERN,
  TELEMETRY_FORM_FACTOR,
  TELEMETRY_INSTALLATION_ID_PATTERN,
  TELEMETRY_LICENSE_TIERS,
  TELEMETRY_LOCALE_PATTERN,
  TELEMETRY_MAX_BODY_BYTES,
  TELEMETRY_MAX_EVENTS_PER_BATCH,
  TELEMETRY_MAX_INTEGER,
  TELEMETRY_MAX_PROPERTIES_PER_EVENT,
  TELEMETRY_OPERATING_SYSTEMS,
  TELEMETRY_PRODUCTS,
  TELEMETRY_PROPERTY_KEY_PATTERN,
  TELEMETRY_PROPERTY_VALUE_PATTERN,
  isValidTelemetryEventName,
  isValidTelemetryInstallationId,
  isValidTelemetryPropertyKey,
  isValidTelemetryPropertyStringValue,
  type TelemetryFormFactor,
  type TelemetryLicenseTier,
  type TelemetryOperatingSystem,
  type TelemetryProduct,
} from './vocabulary';

export {
  TELEMETRY_EVENTS,
  TELEMETRY_SIZE_BUCKETS,
  coalesceTelemetryEvents,
  sanitizeTelemetryEvent,
  sanitizeTelemetryProperties,
  telemetrySizeBucket,
  type TelemetryBatchEntry,
  type TelemetryEvent,
  type TelemetryEventName,
  type TelemetryPropertyValue,
  type TelemetrySizeBucket,
} from './events';

export {
  TELEMETRY_PRODUCTION_ENDPOINT,
  TELEMETRY_STAGING_ENDPOINT,
  buildTelemetryPayload,
  hostTelemetryOperatingSystem,
  normalizeTelemetryLocale,
  telemetryEndpointFor,
  telemetrySessionStart,
  type TelemetryEnvelopeFields,
  type TelemetryPayload,
} from './envelope';

export {
  InMemoryTelemetryInstallationIdStorage,
  TELEMETRY_INSTALLATION_ID_STORAGE_KEY,
  readOrMintTelemetryInstallationId,
  type TelemetryInstallationIdStorage,
} from './installation-id';

export {
  FakeTelemetryGateHost,
  vscodeTelemetryGateHost,
  type TelemetryGateHost,
} from './gate';

export {
  RecordingTelemetrySender,
  fetchTelemetrySender,
  type TelemetrySender,
} from './sender';

export { TelemetryClient, type TelemetryClientOptions } from './client';
