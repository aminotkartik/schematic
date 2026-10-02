/* EcoSwitch. A local, dependency-free engineering prototype.
 * All views read `state`; SVGs do not maintain their own simulation state.
 * GPIO positions and connection plans are illustrative, not a fabrication drawing.
 */
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const WARNING_AT = 600;
  const SHUTDOWN_AT = 900;
  const VALIDATION_MS = 350;
  const QUICK_OFF_SECONDS = 15; // real seconds from "Remove presence" to lights/fans OFF, independent of sim speed
  const EVENT_LIMIT = 20;
  const pad = value => String(Math.floor(value)).padStart(2, '0');
  const zoneName = index => `Zone ${pad(index + 1)}`;
  const clock = seconds => `${pad(Math.max(0, seconds) / 60)}:${pad(Math.max(0, seconds) % 60)}`;
  const initialZones = () => [true, false, true].map((presence, index) => ({
    id: index + 1, rawPresence: presence, occupied: presence, manual: false,
    pending: null, state: presence ? 'ACTIVE' : 'IDLE', powered: true,
    idleSeconds: 0, offSeconds: 0, shutdownSeconds: 0, savedWh: 0,
    fanSpeed: 128, fanAngle: index * 39, sensorPulseUntil: 0, quickOff: null
  }));

  // The single source of truth. Only this object is changed by interaction/timing.
  const state = {
    zones: initialZones(), selectedZone: 1, elapsed: 0, epoch: Date.now(),
    running: true, speed: 1, lightWatts: 40, fanWatts: 50, resistance: 220,
    pir: [{ pulseUntil: 0 }, { pulseUntil: 0 }], buzzerActive: false,
    muted: false, audioEnabled: false, wiring: false, selectedWire: null,
    selectedPin: 4, selectedComponent: null, componentFilter: 'all', events: [], eventSequence: 0
  };

  const pins = [
    { pin: 4, fn: 'Presence input', device: 'mmWave · Zone 01', type: 'Validated logical input', zone: 0, kind: 'presence', wire: 'mm1' },
    { pin: 5, fn: 'Presence input', device: 'mmWave · Zone 02', type: 'Validated logical input', zone: 1, kind: 'presence', wire: 'mm2' },
    { pin: 6, fn: 'Presence input', device: 'mmWave · Zone 03', type: 'Validated logical input', zone: 2, kind: 'presence', wire: 'mm3' },
    { pin: 7, fn: 'Activity input', device: 'PIR 01 · Zones 01 + 02', type: 'Digital activity pulse', pir: 0, kind: 'pir', wire: 'pir1' },
    { pin: 10, fn: 'Activity input', device: 'PIR 02 · Zones 02 + 03', type: 'Digital activity pulse', pir: 1, kind: 'pir', wire: 'pir2' },
    { pin: 11, fn: 'Manual power hold', device: 'Override switch 01', type: 'Debounced logical input', zone: 0, kind: 'manual', wire: 'override1' },
    { pin: 12, fn: 'Manual power hold', device: 'Override switch 02', type: 'Debounced logical input', zone: 1, kind: 'manual', wire: 'override2' },
    { pin: 13, fn: 'Manual power hold', device: 'Override switch 03', type: 'Debounced logical input', zone: 2, kind: 'manual', wire: 'override3' },
    { pin: 14, fn: 'Light proxy control', device: 'LED / Light 01 · series resistor', type: 'Low-current digital output', zone: 0, kind: 'light', wire: 'light1' },
    { pin: 15, fn: 'Light proxy control', device: 'LED / Light 02 · series resistor', type: 'Low-current digital output', zone: 1, kind: 'light', wire: 'light2' },
    { pin: 16, fn: 'Light proxy control', device: 'LED / Light 03 · series resistor', type: 'Low-current digital output', zone: 2, kind: 'light', wire: 'light3' },
    { pin: 17, fn: 'Motor gate control', device: 'MOSFET gate 01 → Motor / Fan 01', type: '3.3 V logic control', zone: 0, kind: 'motor', wire: 'fan1' },
    { pin: 18, fn: 'Motor gate control', device: 'MOSFET gate 02 → Motor / Fan 02', type: '3.3 V logic control', zone: 1, kind: 'motor', wire: 'fan2' },
    { pin: 21, fn: 'Motor gate control', device: 'MOSFET gate 03 → Motor / Fan 03', type: '3.3 V logic control', zone: 2, kind: 'motor', wire: 'fan3' },
    { pin: 8, fn: 'I2C data · SDA', device: '0.9-inch I2C OLED', type: 'I2C data', kind: 'data', wire: 'sda' },
    { pin: 9, fn: 'I2C clock · SCL', device: '0.9-inch I2C OLED', type: 'I2C clock', kind: 'data', wire: 'scl' },
    { pin: 47, fn: 'Warning feedback', device: 'Buzzer control / suitable driver', type: 'Digital / tone control', kind: 'buzzer', wire: 'buzzer' }
  ];
  const leftPins = [4, 5, 6, 7, 10, 11, 12, 13, 14];
  const rightPins = [15, 16, 17, 18, 21, 8, 9, 47];

  const components = [
    { id: 'esp32', name: 'ESP32-S3 development board', role: 'CONTROLLER', category: 'control', quantity: '×1', signal: 'GPIO / I2C · 3.3 V LOGIC', purpose: 'Processes sensor inputs and controls the classroom zones.', input: '3 presence channels, 2 PIR channels, 3 overrides', output: '3 LEDs, 3 motor gates, I2C OLED, buzzer control', power: '3.3 V logic. Use USB or an approved regulated board supply.', connections: 'GPIO 4–7, 10–18, 21, 8, 9, 47 · proposed map', detail: 'Runs the input validation, independent zone state machines, inactivity timing, warning feedback, and output control. The browser models the same control architecture.', note: 'Pin positions are illustrative. Verify pin availability and board-specific functions against your exact ESP32-S3 development board.' },
    { id: 'mmwave', name: 'S3KM1110 24 GHz mmWave', role: 'PRESENCE SENSING', category: 'sensing', quantity: '×3', signal: 'RADAR / SIMULATED INPUT', purpose: 'Detects presence and micro-motion, one channel per zone.', input: 'Reflections and micro-motion in the sensing region', output: 'Simulated validated presence; real interface depends on module', power: 'Verify the selected module’s supply and logic specifications.', connections: 'Proposed logical inputs: GPIO 4, 5, 6', detail: '24 GHz FMCW radar detects human presence and micro-motion within the configured sensing region. The three logical radar channels are simulated by latched inputs in this demo.', note: 'Radar reflections from static objects and environmental geometry require appropriate placement and calibration. Confirm the sensor’s actual communication interface; do not assume a direct GPIO connection.' },
    { id: 'pir', name: 'PIR activity sensors', role: 'MOTION / ACTIVITY', category: 'sensing', quantity: '×2', signal: 'DIGITAL ACTIVITY PULSE', purpose: 'Restarts the inactivity grace period when movement is detected.', input: 'Changes in infrared radiation associated with movement', output: 'Momentary activity event', power: 'Module-specific. Check supply and output voltage.', connections: 'GPIO 7 → PIR 01 · GPIO 10 → PIR 02', detail: 'PIR 01 covers Zones 01 and 02; PIR 02 covers Zones 02 and 03 in this demonstration. A trigger resets relevant timers and restores their grace-period power without asserting continuous occupancy.', note: 'PIR detects movement/activity rather than continuously proving that a person remains present.' },
    { id: 'led', name: 'LED light indicators', role: 'CLASSROOM LIGHT PROXY', category: 'power', quantity: '×3', signal: 'LOW-CURRENT GPIO OUTPUT', purpose: 'Represents the three independently controlled classroom lights.', input: 'Zone power command through a series resistor', output: 'Light indication · ON / WARNING / OFF', power: 'Low-current LED circuit, not a 40 W GPIO load.', connections: 'GPIO 14, 15, 16 → series resistor → LED', detail: 'Three physical LEDs stand in for classroom luminaires. The classroom visual uses warm illumination for ON, amber for WARNING, and dim fixtures for OFF.', note: 'Choose a current-limiting resistor for the LED’s forward voltage and a safe GPIO current. Real classroom lighting requires appropriately rated isolated switching hardware.' },
    { id: 'motor', name: '5 V CD/DVD DC motors', role: 'PROTOTYPE MOTOR LOAD', category: 'power', quantity: '×3', signal: 'SWITCHED REGULATED POWER', purpose: 'Prototype motor load representing the three classroom fans.', input: 'Regulated 5 V motor supply, switched by a MOSFET', output: 'Shaft rotation / simulated ceiling fan', power: '5 V DC per the prototype brief. Actual current must be verified.', connections: 'GPIO 17, 18, 21 → MOSFET gates · flyback protection', detail: 'Small CD/DVD motors model switched inductive loads. Ceiling-fan blades in every live view rotate from the same zone command and coast to a stop after shutdown.', note: 'The 50 W fan energy assumption is not a specification for these motors. Size the regulated supply and switching devices for actual running and stall current.' },
    { id: 'mosfet', name: 'Logic-level N-channel MOSFETs', role: 'ELECTRONIC POWER SWITCH', category: 'power', quantity: '×3', signal: 'GPIO → GATE → LOAD', purpose: 'Switches a higher-current motor with a low-current control signal.', input: '3.3 V gate control with a 10 kΩ pull-down', output: 'Low-side motor power switching', power: 'Load rating and RDS(on) depend on the selected part.', connections: 'Gate → GPIO 17 / 18 / 21 · drain → motor · source → GND', detail: 'The MOSFET acts as the electronic switch between the ESP32 control signal and the higher-current motor load. The illustration identifies gate, drain, and source.', note: 'Select a part with specified low RDS(on) at 3.3 V gate drive. A low threshold voltage alone does not prove suitability. Verify dissipation, current ratings, and the actual pinout.' },
    { id: 'diode', name: '1N4007 flyback diodes', role: 'INDUCTIVE LOAD PROTECTION', category: 'power', quantity: '×3', signal: 'TRANSIENT SUPPRESSION', purpose: 'Provides a return path for a motor’s turn-off voltage transient.', input: 'Inductive turn-off transient', output: 'Clamped flyback current path', power: 'Select and verify diode suitability for the actual load.', connections: 'Cathode stripe → +5 V motor rail · anode → drain / motor−', detail: 'The flyback diode suppresses the voltage spike generated by an inductive motor when switched off. The stripe marks the cathode, not the anode.', note: '1N4007 is the specified prototype part. Verify its current, switching behavior, and suitability for your motor and control frequency.' },
    { id: 'resistor', name: '220 Ω / 330 Ω resistors', role: 'LED CURRENT LIMITING', category: 'power', quantity: '×3', signal: 'PASSIVE / SERIES RESISTANCE', purpose: 'Limits current in each low-current LED indicator channel.', input: 'LED drive voltage', output: 'Limited LED current', power: 'Choose wattage from calculated dissipation; not specified here.', connections: 'GPIO 14 / 15 / 16 ↔ LED 01 / 02 / 03', detail: 'One series resistor per LED. Select 220 Ω or 330 Ω in this technical view to inspect the corresponding four-band color code.', note: '220 Ω: red–red–brown. 330 Ω: orange–orange–brown. Gold is shown as an illustrative tolerance band. Calculate the real value for your LED and permitted drive current.' },
    { id: 'pull-down', name: '10 kΩ gate pull-downs', role: 'DEFINED MOSFET GATE STATE', category: 'power', quantity: '×3', signal: 'PASSIVE / GATE → GROUND', purpose: 'Keeps each motor-switch gate from floating.', input: 'MOSFET gate node', output: 'Defined low gate when the control signal is absent', power: 'Resistor wattage depends on the circuit; not specified.', connections: 'MOSFET gate 01 / 02 / 03 → common GND', detail: 'A 10 kΩ resistor connects each gate to source/common ground in the proposed low-side motor circuit. The shown code is brown–black–orange, with an illustrative gold tolerance band.', note: 'This passive hardware safeguard is distinct from browser reset behavior. Verify the chosen MOSFET pinout and complete circuit before assembly.' },
    { id: 'oled', name: '0.9-inch I2C OLED', role: 'ON-DEVICE STATUS', category: 'control', quantity: '×1', signal: 'I2C / SDA + SCL', purpose: 'Shows real zone state, load commands, and warning countdowns.', input: 'The same simulation state as the classroom and dashboard', output: 'Monochrome status / warning / shutdown display', power: 'Verify VCC and I2C voltage compatibility for the exact module.', connections: 'GPIO 8 → SDA · GPIO 9 → SCL · power + GND', detail: 'The live monochrome display prioritizes warnings, shows the selected shutdown zone, or presents the three-zone overview. It is never a pre-rendered animation.', note: 'Resolution, I2C address, and operating voltage are not assumed; check the selected 0.9-inch module’s datasheet.' },
    { id: 'buzzer', name: 'Warning buzzer', role: 'AUDIBLE FEEDBACK', category: 'control', quantity: '×1', signal: 'DIGITAL / TONE CONTROL', purpose: 'Signals an approaching zone shutdown.', input: 'Any zone in WARNING', output: 'Visual vibration; optional short browser beep', power: 'Buzzer type and current are unspecified. A driver may be needed.', connections: 'GPIO 47 → suitable buzzer control circuit', detail: 'The buzzer is active whenever at least one zone is in WARNING. Muting audio does not cancel the warning or stop the countdown.', note: 'Browser audio is opt-in. An active buzzer and a passive transducer need different hardware drive strategies; verify the exact part before connecting it to the controller.' },
    { id: 'switch', name: 'Push buttons / switches', role: 'SIMULATED INPUT + OVERRIDE', category: 'control', quantity: '×6', signal: 'DEBOUNCED LOGICAL INPUT', purpose: 'Three simulated presence inputs and three manual power holds.', input: 'User actuation', output: 'Latched presence or manual override in the demonstration', power: 'Controller-compatible input circuits; verify wiring and biasing.', connections: 'Presence → GPIO 4 / 5 / 6 · override → GPIO 11 / 12 / 13', detail: 'The upper three buttons simulate radar zone inputs. The lower three latch a manual override, keeping power on without falsely increasing the occupied-zone count.', note: 'The demo uses latched buttons for clarity. A physical momentary switch requires appropriate biasing, debounce, and explicitly defined polarity.' },
    { id: 'breadboard', name: 'Solderless breadboard', role: 'PROTOTYPE ASSEMBLY', category: 'control', quantity: '×1', signal: 'POWER / DATA / GPIO', purpose: 'Organizes low-voltage prototype connections.', input: 'Regulated power and controller connections', output: 'Terminal-strip and rail interconnections', power: 'Low-voltage prototype only. Verify rail continuity and ratings.', connections: 'Power rails, center groove, terminal strips, jumper wires', detail: 'The illustration shows separate rails, the center channel, connected indicators, switching components, and animated wiring. It is a spatial illustration, not a verified terminal-by-terminal layout.', note: 'Do not route mains lighting or unverified high-current motor loads through a solderless breadboard.' },
    { id: 'wires', name: 'Jumper wires', role: 'THE CONNECTION LAYER', category: 'control', quantity: 'SET', signal: 'POWER / DATA / GPIO / GND', purpose: 'Carries power, sensor signals, and control between components.', input: 'A component terminal or controller pin', output: 'Its assigned destination', power: 'Wire gauge and connection ratings must suit the circuit.', connections: 'Select a colored wire in the complete circuit to inspect endpoints.', detail: 'Amber denotes power, cyan data, green GPIO, gray ground, and copper sensor signals. Live pulses show logical activity, not measured voltage or current.', note: 'Keep signal-voltage compatibility and a common ground in mind. Wire animation is a demonstration, not an electrical measurement.' },
    { id: 'battery', name: 'Power supply representations', role: 'PHYSICAL PROTOTYPE PLANNING', category: 'power', quantity: '×2', signal: 'PLANNING ONLY / NOT CONNECTED', purpose: 'Makes the planned power source visible in the prototype layout.', input: 'Not connected directly to any load in this plan', output: 'Appropriate regulation would be required', power: 'Representation only. Controller and motor rails differ.', connections: 'A suitable regulated supply is required; no direct supply-to-load path.', detail: 'For physical prototype planning only; use an appropriately regulated supply for the actual loads and controller.', note: 'Never connect the power supply directly to the 5 V motors or the ESP32. Verify voltage regulation, available current, and all supply limits.' }
  ];

  const wires = pins.map(pin => ({
    id: pin.wire, pin: pin.pin, zone: pin.zone, pir: pin.pir, kind: pin.kind,
    from: ['presence', 'pir', 'manual'].includes(pin.kind) ? pin.device : `ESP32-S3 · GPIO ${pin.pin}`,
    to: ['presence', 'pir', 'manual'].includes(pin.kind) ? `ESP32-S3 · GPIO ${pin.pin}` : pin.device,
    type: ['presence', 'pir'].includes(pin.kind) ? 'sensor' : pin.kind === 'data' ? 'data' : 'gpio',
    signal: pin.type,
    purpose: pin.kind === 'presence' ? 'Proposed logical presence channel. This browser models a validated boolean; verify the real radar module interface before wiring.' : pin.kind === 'pir' ? 'Registers movement and resets the inactivity grace period for the associated zones, without asserting continuous presence.' : pin.kind === 'manual' ? 'Keeps the selected zone powered without changing its occupancy reading.' : pin.kind === 'light' ? `Drives the low-current Light ${pad(pin.zone + 1)} LED proxy through its current-limiting resistor. Not a direct classroom luminaire connection.` : pin.kind === 'motor' ? `Commands MOSFET gate ${pad(pin.zone + 1)}, switching the regulated 5 V motor load. A 10 kΩ gate pull-down and flyback diode complete the proposed driver.` : pin.kind === 'data' ? 'Updates the live I2C OLED. Verify the actual display voltage, address, and pull-up requirements.' : 'Controls warning feedback through a buzzer-appropriate driver. Browser sound is a separate, opt-in representation.'
  }));
  wires.push(
    { id: 'logic-power', from: 'Appropriate regulated logic supply', to: 'ESP32-S3 · approved power input', type: 'power', signal: 'Regulated controller power', kind: 'supply', purpose: 'Use a supply compatible with the exact development board. 3.3 V is the logic level, not a universal instruction for every board power input.' },
    { id: 'motor-power', from: 'Regulated 5 V motor supply', to: 'Motor 01 / 02 / 03 positive terminals', type: 'power', signal: '5 V motor rail', kind: 'supply', purpose: 'Supplies the motors independently of GPIO. Verify running/stall current and supply capacity. Never substitute a direct, unregulated supply connection.' },
    { id: 'ground', from: 'Controller / sensor / supply GND', to: 'MOSFET sources + gate pull-downs', type: 'ground', signal: 'Common low-voltage reference', kind: 'ground', purpose: 'Connects the low-voltage reference across compatible circuit sections. Not a protective-earth or mains-wiring diagram.' },
    ...[0, 1, 2].map(zone => ({ id: `flyback${zone + 1}`, from: `Motor− / MOSFET drain ${pad(zone + 1)}`, to: 'Motor +5 V rail · diode cathode', type: 'power', signal: 'Turn-off transient return path', kind: 'flyback', zone, purpose: 'The 1N4007 is reverse-biased during normal motor power. Its cathode stripe faces the positive motor supply; its anode faces the motor negative/drain node.' })),
    { id: 'assembly', from: 'ESP32-S3 low-voltage headers', to: 'Breadboard + jumper-wire assembly', type: 'data', signal: 'Illustrative assembly bundle', kind: 'data', purpose: 'A spatial representation of low-voltage assembly. The pin-by-pin connection map, not this bundled line, describes logical assignments.' }
  );

  let dirty = true;
  let lastFrame = performance.now();
  let lastSimulationTick = performance.now();
  let simulationTimer;
  let lastRender = 0;
  let animationId;
  let toastTimeout;
  let audioContext = null;
  let lastBeep = 0;
  let modalInvoker = null;
  let modalKind = null;
    let fanNodes = [];
  let revealObserver;

  const svg = (content, viewBox, label, extra = '') => `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" role="${extra.includes('role=\"group\"') ? 'group' : 'img'}" aria-label="${label}" ${extra.replace('role=\"group\"','')}>${content}</svg>`;
  const part = (name, x, y, width, height) => `<use href="#part-${name}" x="${x}" y="${y}" width="${width}" height="${height}"/>`;

  function createSymbolLibrary() {
    const headers = Array.from({ length: 16 }, (_, i) => `<rect x="15" y="${53 + i * 13}" width="12" height="8" rx="1" fill="#c7b383"/><rect x="183" y="${53 + i * 13}" width="12" height="8" rx="1" fill="#c7b383"/><rect x="19" y="${55 + i * 13}" width="4" height="4" fill="#514b3e"/><rect x="187" y="${55 + i * 13}" width="4" height="4" fill="#514b3e"/>`).join('');
    const resistor = (id, bands, value) => `<symbol id="part-${id}" viewBox="0 0 200 100"><path d="M17 51h43m80 0h44" stroke="#aaa896" stroke-width="3"/><circle cx="17" cy="51" r="3" fill="#c9c2aa"/><circle cx="184" cy="51" r="3" fill="#c9c2aa"/><path d="M60 39q-8 12 0 24h81q9-12 0-24Z" fill="url(#resistor-body)" stroke="#7d684b"/>${bands.map((color, i) => `<path d="M${73 + i * 13} 39v24" stroke="${color}" stroke-width="7"/>`).join('')}<path d="M133 39v24" stroke="#c3a354" stroke-width="5"/><path d="M64 42h73" stroke="#fff2c8" opacity=".22"/><text x="100" y="83" class="part-pin-label">${value}</text></symbol>`;
    document.body.insertAdjacentHTML('afterbegin', `<svg class="svg-library" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
      <linearGradient id="pcb" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#3f574d"/><stop offset="1" stop-color="#243c34"/></linearGradient>
      <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#c7c8bc"/><stop offset=".4" stop-color="#a2a69b"/><stop offset=".6" stop-color="#d5d2be"/><stop offset="1" stop-color="#747d75"/></linearGradient>
      <linearGradient id="motor-metal" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#929b92"/><stop offset=".3" stop-color="#d5d4c3"/><stop offset=".7" stop-color="#a4a899"/><stop offset="1" stop-color="#606a61"/></linearGradient>
      <linearGradient id="resistor-body" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#c2a67c"/><stop offset=".45" stop-color="#e0c99e"/><stop offset="1" stop-color="#a58a65"/></linearGradient>
      <radialGradient id="pir-lens" cx=".4" cy=".35"><stop stop-color="#f0ecda"/><stop offset=".7" stop-color="#d4d5c4"/><stop offset="1" stop-color="#afb3a5"/></radialGradient>
      <linearGradient id="battery-body" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#393831"/><stop offset=".5" stop-color="#4a4840"/><stop offset="1" stop-color="#272821"/></linearGradient>
      <linearGradient id="battery-copper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d3a167"/><stop offset="1" stop-color="#a77743"/></linearGradient>
      <linearGradient id="window-glass" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#e8d7b2"/><stop offset=".5" stop-color="#d1c6a8"/><stop offset="1" stop-color="#97aaa3"/></linearGradient>
      <pattern id="bb-holes" width="11" height="11" patternUnits="userSpaceOnUse"><circle cx="5.5" cy="5.5" r="1.8" fill="#625c51"/><circle cx="5.3" cy="5.1" r=".85" fill="#3d3c35"/></pattern>
      <filter id="soft-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5"/></filter>
      <symbol id="part-fan-blade" viewBox="-65 -65 130 130"><path class="room-fan-blade" d="M4-5C18-15 47-14 55-6Q61 4 51 9L9 7Z"/></symbol>
      <symbol id="part-esp32" viewBox="0 0 210 322"><rect x="19" y="8" width="174" height="299" rx="10" fill="#101b16"/><rect x="17" y="5" width="176" height="300" rx="8" fill="url(#pcb)" stroke="#80917b" stroke-width="1"/><path d="M36 90h20v50h14M176 100h-24v50h-9M35 190h18v42h25M172 196h-20v38h-16M51 272v-21h22" fill="none" stroke="#a7aa6b" stroke-width="1" opacity=".4"/>${headers}<rect x="67" y="14" width="78" height="72" rx="3" fill="#1b251e"/><path d="M76 32h58v7H80v7h53v7H80v7h53v7H76" fill="none" stroke="#b7a775" stroke-width="2.5"/><text x="105" y="80" font-size="5" fill="#899882" text-anchor="middle">2.4 GHz ANTENNA</text><rect x="60" y="95" width="89" height="115" rx="4" fill="#1a241e"/><rect x="65" y="98" width="79" height="101" rx="3" fill="url(#metal)" stroke="#d2d2be" stroke-width=".7"/><path d="M68 102h71v92H68Z" fill="none" stroke="#616f63" opacity=".32"/><text x="105" y="138" text-anchor="middle" font-size="12" fill="#485247">ESP32</text><text x="105" y="154" text-anchor="middle" font-size="9" fill="#485247">S3</text><text x="105" y="176" text-anchor="middle" font-size="5" fill="#586353">DUAL-CORE MCU</text><text x="105" y="186" text-anchor="middle" font-size="4.5" fill="#65705f">ILLUSTRATIVE MODULE</text><rect x="77" y="224" width="31" height="24" fill="#17211b" stroke="#8e957b" stroke-width=".5"/><path d="M74 228h-4m4 5h-4m4 5h-4m41-10h4m-4 5h4m-4 5h4" stroke="#bfb99c" stroke-width="2"/><rect x="128" y="227" width="9" height="17" fill="#bab69e"/><rect x="43" y="257" width="23" height="16" rx="3" fill="#a6afa0"/><circle cx="54.5" cy="265" r="5.5" fill="#3c4a3d"/><rect x="145" y="257" width="23" height="16" rx="3" fill="#a6afa0"/><circle cx="156.5" cy="265" r="5.5" fill="#3c4a3d"/><text x="55" y="282" font-size="5" fill="#b7c1ab" text-anchor="middle">BOOT</text><text x="156" y="282" font-size="5" fill="#b7c1ab" text-anchor="middle">RESET</text><rect x="82" y="277" width="46" height="35" rx="5" fill="url(#metal)" stroke="#777e70"/><rect x="88" y="302" width="34" height="6" rx="2" fill="#22281f"/><path d="M92 305h26" stroke="#ab9f75" stroke-width="1.5"/><circle cx="48" cy="239" r="3" fill="#c4e79c"/><circle cx="35" cy="22" r="4.2" fill="#1c2a22" stroke="#9ea488"/><circle cx="175" cy="22" r="4.2" fill="#1c2a22" stroke="#9ea488"/><circle cx="35" cy="290" r="4.2" fill="#1c2a22" stroke="#9ea488"/><circle cx="175" cy="290" r="4.2" fill="#1c2a22" stroke="#9ea488"/><text x="43" y="216" font-size="5" fill="#a5b29a">3V3</text><text x="153" y="216" font-size="5" fill="#a5b29a">GND</text></symbol>
      <symbol id="part-mmwave" viewBox="0 0 200 150"><path d="M41 119v20m20-20v20m20-20v20m20-20v20m20-20v20" stroke="#bfb596" stroke-width="4"/><rect x="22" y="35" width="157" height="90" rx="5" fill="#243a37" stroke="#79938a"/><path d="M29 107h26V64h16M120 108h23V87h24" fill="none" stroke="#aa9d60" opacity=".45"/><rect x="82" y="41" width="88" height="57" rx="3" fill="#b3b9a6" stroke="#d4d5bc"/><rect x="91" y="48" width="70" height="42" fill="#c6c5ad"/><path d="M96 53h19v10H98v10h19v11M122 53h32v30h-27v-8h20V61h-21" fill="none" stroke="#9a905b" stroke-width="2"/><rect x="40" y="57" width="26" height="31" fill="#182520" stroke="#959e86" stroke-width=".5"/><path d="M37 63h-5m5 7h-5m5 7h-5m37-14h4m-4 7h4m-4 7h4" stroke="#b3b49d" stroke-width="2"/><circle cx="153" cy="110" r="3" class="part-active-led"/><text x="36" y="108" font-size="7" fill="#d9d7bc">S3KM1110</text><text x="141" y="118" font-size="5" fill="#abbfae">24 GHz</text><circle cx="29" cy="42" r="3" fill="#192c25" stroke="#a5b197"/><circle cx="171" cy="118" r="3" fill="#192c25" stroke="#a5b197"/><text x="41" y="148" class="part-pin-label">PWR</text><text x="95" y="148" class="part-pin-label">DATA*</text></symbol>
      <symbol id="part-pir" viewBox="0 0 200 150"><path d="M83 119v22m19-22v22m19-22v22" stroke="#bdb593" stroke-width="4"/><path d="M40 70h119l7 52H35Z" fill="url(#pcb)" stroke="#7a927b"/><rect x="44" y="94" width="17" height="19" rx="2" fill="#af7951"/><path d="M47 100h11" stroke="#dfcaa3" stroke-width="2"/><rect x="142" y="91" width="15" height="19" rx="2" fill="#af7951"/><path d="M145 98h9" stroke="#dfcaa3" stroke-width="2"/><ellipse cx="100" cy="80" rx="48" ry="39" fill="#596655"/><circle cx="100" cy="58" r="43" fill="url(#pir-lens)" stroke="#a6b5a2"/><g fill="none" stroke="#b1b8a6" stroke-width=".8" opacity=".7"><ellipse cx="100" cy="58" rx="14" ry="41"/><ellipse cx="100" cy="58" rx="29" ry="42"/><path d="M60 42q40 15 80 0M59 61q41 17 82 0M69 80q31 15 62 0"/></g><ellipse cx="85" cy="37" rx="12" ry="7" fill="#fffde9" opacity=".17"/><text x="100" y="116" font-size="5.5" fill="#c6d2b6" text-anchor="middle">PIR ACTIVITY</text><text x="83" y="149" class="part-pin-label">+</text><text x="102" y="149" class="part-pin-label">OUT</text><text x="121" y="149" class="part-pin-label">−</text></symbol>
      <symbol id="part-led" viewBox="0 0 200 150"><circle cx="100" cy="49" r="38" class="part-led-glow" filter="url(#soft-glow)"/><path d="M90 79v49m20-49v34" stroke="#b1b5a2" stroke-width="3"/><path d="M77 67V45a23 23 0 0 1 46 0v22Z" class="part-led-dome" stroke="#bfb184"/><ellipse cx="100" cy="67" rx="25" ry="8" fill="#b4a77d"/><path d="M86 61V43q0-13 13-16" stroke="#fff2c5" fill="none" opacity=".55" stroke-width="4" stroke-linecap="round"/><path d="M94 62v-7h10v7" fill="none" stroke="#857954"/><text x="90" y="145" class="part-pin-label">ANODE +</text><text x="130" y="126" class="part-pin-label">K −</text></symbol>
      <symbol id="part-motor" viewBox="0 0 200 160"><path d="M46 103 22 122m35-17-14 30" stroke="#928e76" stroke-width="3"/><path d="M57 50h80v64H57Z" fill="url(#motor-metal)"/><ellipse cx="57" cy="82" rx="20" ry="32" fill="#7b887c" stroke="#b0b9a3"/><ellipse cx="137" cy="82" rx="13" ry="32" fill="#a3ac9c" stroke="#6d7b6f"/><ellipse cx="57" cy="82" rx="12" ry="21" fill="#94a08b"/><circle cx="56" cy="81" r="7" fill="#647264"/><path d="M149 79h38v6h-38" fill="url(#metal)" stroke="#727a6b" stroke-width=".5"/><rect x="40" y="101" width="8" height="12" fill="#b7946e"/><rect x="63" y="106" width="8" height="12" fill="#a3947a"/><path d="M84 56h5m9 0h5m9 0h5" stroke="#626e63" stroke-width="3"/><text x="99" y="80" font-size="9" text-anchor="middle" fill="#505d50">5 V DC</text><text x="99" y="94" font-size="6" text-anchor="middle" fill="#687361">CD / DVD</text><text x="24" y="141" class="part-pin-label">+</text><text x="48" y="149" class="part-pin-label">−</text></symbol>
      <symbol id="part-mosfet" viewBox="0 0 200 155"><rect x="76" y="12" width="48" height="41" rx="3" fill="url(#metal)" stroke="#8e9788"/><circle cx="100" cy="28" r="7" fill="#25251e" stroke="#6c7566" stroke-width="2"/><path d="M78 106v30m22-30v30m22-30v30" stroke="#a1a793" stroke-width="5"/><rect x="64" y="44" width="72" height="65" rx="3" fill="#363b32" stroke="#626c5d"/><path d="M68 46h64v6H68Z" fill="#4e5747"/><text x="100" y="75" font-size="9" fill="#c0c5ac" text-anchor="middle">N-CHANNEL</text><text x="100" y="90" font-size="7" fill="#929f87" text-anchor="middle">LOGIC LEVEL</text><text x="78" y="150" class="part-pin-label">GATE</text><text x="100" y="150" class="part-pin-label">D</text><text x="123" y="150" class="part-pin-label">S</text><path d="M15 89h28v42h31" class="part-mosfet-signal"/><circle cx="15" cy="89" r="3" fill="#a0be83"/><text x="25" y="81" font-size="5" fill="#8f9f7c">GPIO</text></symbol>
      <symbol id="part-diode" viewBox="0 0 200 100"><path d="M19 48h49m62 0h51" stroke="#b2b4a0" stroke-width="3"/><rect x="67" y="33" width="66" height="30" rx="5" fill="#353831" stroke="#69725f"/><path d="M72 37h54" stroke="#797d6a" opacity=".3"/><rect x="120" y="34" width="8" height="28" fill="#c2c3ad"/><text x="91" y="51" font-size="7" fill="#b3b8a2" text-anchor="middle">1N4007</text><text x="20" y="71" class="part-pin-label">A</text><text x="178" y="71" class="part-pin-label">K</text><path d="M39 68q61 40 123-1" class="part-diode-protection"/><path d="m156 66 6 1-3 6" fill="none" stroke="#89c8ce" opacity=".4"/></symbol>
      ${resistor('resistor220', ['#9d453d', '#9d453d', '#75513d'], '220 Ω')}
      ${resistor('resistor330', ['#c58143', '#c58143', '#75513d'], '330 Ω')}
      ${resistor('pulldown', ['#76513b', '#31342b', '#c17e42'], '10 kΩ')}
      <symbol id="part-oled" viewBox="0 0 200 150"><rect x="7" y="5" width="186" height="140" rx="5" fill="#263a36" stroke="#75918a"/><path d="M13 13h34v16M186 113h-26v22" fill="none" stroke="#729282" opacity=".5"/><circle cx="16" cy="13" r="3.5" fill="#202823" stroke="#b2b398"/><circle cx="184" cy="13" r="3.5" fill="#202823" stroke="#b2b398"/><circle cx="16" cy="137" r="3.5" fill="#202823" stroke="#b2b398"/><circle cx="184" cy="137" r="3.5" fill="#202823" stroke="#b2b398"/><rect x="58" y="5" width="84" height="10" rx="2" fill="#17241e"/><g fill="#bdba94"><rect x="65" y="6" width="5" height="7"/><rect x="87" y="6" width="5" height="7"/><rect x="109" y="6" width="5" height="7"/><rect x="131" y="6" width="5" height="7"/></g><g font-size="5" fill="#b5c1ab" text-anchor="middle"><text x="67" y="24">GND</text><text x="89" y="24">VCC</text><text x="111" y="24">SCL</text><text x="133" y="24">SDA</text></g><rect x="22" y="30" width="156" height="97" rx="3" fill="#151d18" stroke="#637061"/><rect x="28" y="35" width="144" height="86" rx="1" fill="#020505"/><path d="M24 126h152" stroke="#828873" opacity=".5"/><text x="100" y="140" font-size="5" fill="#9baf9b" text-anchor="middle">0.9-INCH OLED · I2C</text></symbol>
      <symbol id="part-buzzer" viewBox="0 0 200 155"><path d="M82 118v30m36-30v30" stroke="#aeb19c" stroke-width="4"/><path d="M55 59v45q0 31 45 31t45-31V59Z" fill="#272d25" stroke="#535e4c"/><ellipse cx="100" cy="60" rx="45" ry="29" fill="#424b3b" stroke="#78806a"/><ellipse cx="100" cy="60" rx="38" ry="23" fill="#323c2f" stroke="#4c5844"/><ellipse cx="100" cy="61" rx="10" ry="7" fill="#111d12" stroke="#59684e"/><text x="122" y="47" font-size="13" fill="#a3af94">+</text><text x="100" y="111" font-size="8" fill="#838f78" text-anchor="middle">BUZZER</text><text x="81" y="153" class="part-pin-label">+</text><text x="119" y="153" class="part-pin-label">−</text></symbol>
      <symbol id="part-switch" viewBox="0 0 170 120"><path d="M48 48H34m14 23H34m88-23h14m-14 23h14" stroke="#a5a793" stroke-width="5"/><rect x="47" y="35" width="78" height="57" rx="3" fill="#252e24" stroke="#56644e"/><rect x="53" y="33" width="66" height="51" rx="3" fill="url(#metal)"/><circle cx="86" cy="59" r="23" fill="#5f6554"/><circle cx="86" cy="57" r="19" class="button-cap" stroke="#ddb993"/><path d="M61 38h8m35 0h9M60 80h8m37 0h8" stroke="#666e5b" stroke-width="2"/><text x="49" y="111" class="part-pin-label">IN</text><text x="123" y="111" class="part-pin-label">GND</text></symbol>
      <symbol id="part-battery" viewBox="0 0 170 210"><path d="m40 53 23-15h89l-23 15v123l-23 15H40Z" fill="#282a22" stroke="#81765b"/><path d="m129 53 23-15v123l-23 15Z" fill="#22271f"/><path d="m40 53 23-15h89l-23 15Z" fill="#a5875c"/><rect x="40" y="52" width="89" height="137" rx="3" fill="url(#battery-body)" stroke="#796c51"/><rect x="40" y="53" width="89" height="46" fill="url(#battery-copper)"/><path d="M46 101h77" stroke="#b39059" stroke-width="1"/><ellipse cx="72" cy="36" rx="10" ry="5" fill="#b8bcab" stroke="#788272"/><path d="M62 29v7q10 7 20 0v-7" fill="url(#metal)"/><ellipse cx="72" cy="29" rx="10" ry="4" fill="#d5d4bf"/><path d="m106 30 6-5 7 4 2 8-7 4-8-5Z" fill="url(#metal)" stroke="#a0a58e"/><text x="85" y="78" font-size="9" fill="#4e3c27" text-anchor="middle" letter-spacing="1">ECOSWITCH</text><text x="85" y="135" font-size="28" fill="#d4c5a2" text-anchor="middle">PSU</text><text x="85" y="155" font-size="6" fill="#aaa689" text-anchor="middle">PLANNING ONLY</text><text x="85" y="176" font-size="5" fill="#899480" text-anchor="middle">REGULATION REQUIRED</text><text x="72" y="20" class="part-pin-label">−</text><text x="114" y="19" class="part-pin-label">+</text></symbol>
      <symbol id="part-breadboard" viewBox="0 0 380 210"><rect x="12" y="21" width="350" height="181" rx="8" fill="#7f7c6b"/><rect x="12" y="15" width="350" height="180" rx="8" fill="#d5ceba" stroke="#eee4c9"/><path d="M20 22h335" stroke="#efe9d7"/><rect x="31" y="48" width="312" height="47" fill="url(#bb-holes)"/><rect x="31" y="117" width="312" height="47" fill="url(#bb-holes)"/><rect x="28" y="100" width="320" height="8" rx="3" fill="#a09d8a"/><path d="M32 104h313" stroke="#797b66"/><path d="M30 28h310M30 174h310" stroke="#b47559" stroke-width="1"/><path d="M30 39h310M30 185h310" stroke="#7b9892" stroke-width="1"/><g font-size="5.5" fill="#88856e"><text x="22" y="32">+</text><text x="22" y="41">−</text><text x="22" y="179">+</text><text x="22" y="189">−</text><text x="20" y="57">A</text><text x="20" y="68">B</text><text x="20" y="79">C</text><text x="20" y="90">D</text><text x="20" y="124">F</text><text x="20" y="136">G</text><text x="20" y="147">H</text><text x="20" y="158">I</text><text x="72" y="46">5</text><text x="127" y="46">10</text><text x="182" y="46">15</text><text x="237" y="46">20</text><text x="292" y="46">25</text></g><path d="M52 32v34q0 9 9 9h34M52 180v-40q0-10 10-10h206M137 67v-15q0-9 9-9h62v85" fill="none" stroke="#a5674c" stroke-width="3"/><path d="M52 32v34q0 9 9 9h34" fill="none" stroke="#e0ab70" stroke-width="1" class="breadboard-flow"/><path d="M52 180v-40q0-10 10-10h206" fill="none" stroke="#667f76" stroke-width="3"/><path d="M93 140v-38q0-9 9-9h135" fill="none" stroke="#839568" stroke-width="3"/><path d="M93 140v-38q0-9 9-9h135" fill="none" stroke="#c0d890" stroke-width="1" class="breadboard-flow"/><use href="#part-led" x="74" y="52" width="47" height="36"/><use href="#part-led" x="120" y="52" width="47" height="36"/><use href="#part-led" x="164" y="52" width="47" height="36"/><use href="#part-resistor220" x="93" y="120" width="60" height="30"/><use href="#part-mosfet" x="236" y="73" width="60" height="47"/><use href="#part-diode" x="221" y="124" width="77" height="39"/><use href="#part-esp32" x="298" y="60" width="37" height="59"/></symbol>
    </defs></svg>`);
  }

  function boardPins() {
    return pins.map(pin => {
      const isLeft = leftPins.includes(pin.pin);
      const i = (isLeft ? leftPins : rightPins).indexOf(pin.pin);
      const y = 56 + i * 13;
      return `<g class="pin-group" data-pin="${pin.pin}" role="button" tabindex="0" aria-label="GPIO ${pin.pin}: ${pin.fn}, ${pin.device}"><title>GPIO ${pin.pin} · ${pin.device}</title><rect class="pin-hit" x="${isLeft ? 8 : 155}" y="${y - 5}" width="47" height="12" rx="2"/><circle class="pin-marker" cx="${isLeft ? 21 : 189}" cy="${y + 1}" r="2.1"/><text class="pin-svg-label" x="${isLeft ? 31 : 179}" y="${y + 3}" text-anchor="${isLeft ? 'start' : 'end'}">${pin.pin}</text></g>`;
    }).join('');
  }

  function board(x = 0, y = 0, width = 210, interactive = true) {
    return `<g transform="translate(${x} ${y}) scale(${width / 210})">${part('esp32', 0, 0, 210, 322)}${interactive ? boardPins() : ''}</g>`;
  }

  function fanRotor(index, radius = 55) {
    const scale = radius / 55;
    return `<g data-fan-rotor data-fan="${index}" transform="rotate(0)"><g transform="scale(${scale})">${[0, 120, 240].map(angle => `<g transform="rotate(${angle})">${part('fan-blade', -65, -65, 130, 130)}</g>`).join('')}<circle class="room-fan-hub" r="9"/><circle r="3" fill="#5a594b"/></g></g>`;
  }

  function oledMarkup() {
    return `<div class="oled-unit" data-oled-unit>${svg(part('oled', 0, 0, 200, 150), '0 0 200 150', '0.9-inch I2C OLED circuit board')}<div class="oled-screen"><canvas width="128" height="64" data-oled-canvas aria-hidden="true"></canvas><pre data-oled-screen aria-label="Live OLED display">ECOSWITCH\nZ1 ACT Z2 IDL Z3 ACT\n\nL: ON ON ON\nF: ON ON ON</pre></div></div>`;
  }

  function oledSvg(x, y, width = 160) {
    return `<g transform="translate(${x} ${y}) scale(${width / 200})">${part('oled', 0, 0, 200, 150)}<svg x="28" y="35" width="144" height="86" viewBox="0 0 128 64" aria-hidden="true"><path data-oled-raster fill="#c7ead2" shape-rendering="crispEdges"/></svg><text data-oled-svg x="33" y="47" font-size="6.6" opacity="0"></text></g>`;
  }

  function buzzerDrawing(x = 0, y = 0, width = 200) {
    return `<g transform="translate(${x} ${y}) scale(${width / 200})"><g class="buzzer-device" data-buzzer-device>${part('buzzer', 0, 0, 200, 155)}<path class="buzzer-wave" d="M157 41q17 18 0 36M169 31q26 28 0 55M43 41q-17 18 0 36M31 31q-26 28 0 55"/></g></g>`;
  }

  function hardwareArtwork(id, expanded = false) {
    if (id === 'esp32') {
      if (expanded) return svg(board(80, 10, 186), '0 0 350 310', 'Interactive ESP32-S3 board: select a highlighted GPIO', 'role="group"');
      return svg(`${board(184, 5, 156)}<g class="board-annotation"><path d="M57 95h109m168 43h98M58 176h101m174 44h98" stroke="#71664d" stroke-width=".6" fill="none"/><circle cx="166" cy="95" r="2" fill="#89c8ce"/><circle cx="334" cy="138" r="2" fill="#bfdf91"/><text x="57" y="76" fill="#89c8ce" font-size="7" letter-spacing="1.6">SENSOR INPUTS</text><text x="57" y="88" fill="#8e8b78" font-size="6">3 mmWAVE / 2 PIR</text><text x="345" y="116" fill="#bfdf91" font-size="7" letter-spacing="1.4">ZONE CONTROL</text><text x="345" y="128" fill="#8e8b78" font-size="6">LIGHT / MOTOR / BUZZER</text><text x="58" y="158" fill="#efa36e" font-size="7" letter-spacing="1.3">17 USED GPIOs</text><text x="58" y="170" fill="#8e8b78" font-size="6">SELECT A PIN TO INSPECT</text><text x="347" y="199" fill="#89c8ce" font-size="7" letter-spacing="1.3">I2C FEEDBACK</text><text x="347" y="212" fill="#8e8b78" font-size="6">LIVE OLED DISPLAY</text></g>`, '0 0 530 260', 'Detailed ESP32-S3 development board with interactive GPIO pins', 'role="group"');
    }
    if (id === 'oled') return oledMarkup();
    if (id === 'breadboard') return svg(part('breadboard', 0, 0, 380, 210), '0 0 380 210', 'Solderless breadboard: power rails, center groove, terminal strips and connected components');
    if (id === 'buzzer') return svg(buzzerDrawing(), '0 0 200 155', 'Physical buzzer with animated warning vibration');
    if (id === 'wires') {
      const examples = [{ name: 'POWER', id: 'motor-power', color: '#e6b75d' }, { name: 'DATA', id: 'sda', color: '#89c8ce' }, { name: 'GPIO', id: 'light1', color: '#bfdf91' }, { name: 'GROUND', id: 'ground', color: '#969187' }, { name: 'SENSOR', id: 'mm1', color: '#efa36e' }];
      return svg(examples.map((wire, i) => `<g data-wire="${wire.id}" role="button" tabindex="0" aria-label="Inspect ${wire.name.toLowerCase()} wire"><title>${wire.name}: select to inspect connection</title><text x="14" y="${26 + i * 26}" font-size="6" fill="${wire.color}">${wire.name}</text><path class="wire-card-hit" d="M68 ${23 + i * 26}C102 ${-5 + i * 26} 131 ${53 + i * 26} 176 ${23 + i * 26}"/><path class="wire-card-line" stroke="${wire.color}" d="M68 ${23 + i * 26}C102 ${-5 + i * 26} 131 ${53 + i * 26} 176 ${23 + i * 26}"/><circle cx="68" cy="${23 + i * 26}" r="3" fill="${wire.color}"/><rect x="175" y="${20 + i * 26}" width="6" height="6" rx="1" fill="#aaa38b"/></g>`).join(''), '0 0 200 155', 'Five interactive types of jumper wire', 'role="group"');
    }
    if (id === 'switch') {
      return svg(Array.from({ length: 6 }, (_, i) => {
        const zone = i % 3;
        const manual = i > 2;
        const x = 5 + zone * 64;
        const y = manual ? 88 : 3;
        return `<g data-switch-zone="${zone}" data-switch-kind="${manual ? 'manual' : 'presence'}" data-action="${manual ? 'manual' : 'presence'}" data-zone="${zone}" role="button" tabindex="0" aria-label="${manual ? 'Manual override' : 'Presence input'} Zone ${pad(zone + 1)}"><title>${manual ? 'Manual override' : 'Simulated mmWave input'} ${pad(zone + 1)}</title>${part('switch', x, y, 63, 53)}<text class="hw-unit-label" x="${x + 32}" y="${y + 68}">${manual ? 'OVERRIDE' : 'PRESENCE'} ${pad(zone + 1)}</text></g>`;
      }).join(''), '0 0 200 170', 'Six interactive physical buttons: three simulated radar inputs and three manual overrides', 'role="group"');
    }
    const partName = id === 'resistor' ? `resistor${state.resistance}` : id === 'pull-down' ? 'pulldown' : id;
    const count = id === 'pir' || id === 'battery' ? 2 : 3;
    const small = ['diode', 'resistor', 'pull-down'].includes(id);
    if (expanded && !['mmwave', 'pir', 'motor', 'led', 'battery'].includes(id)) {
      return svg(part(partName, 0, 0, 200, small ? 100 : 155), `0 0 200 ${small ? 100 : 155}`, `${components.find(item => item.id === id).name} engineering illustration`);
    }
    const width = count === 2 ? 96 : 77;
    const height = id === 'battery' ? 123 : small ? 55 : 87;
    const viewWidth = count === 2 ? 220 : 250;
    const viewHeight = id === 'battery' ? 161 : small ? 145 : 153;
    const yBase = small ? 25 : id === 'battery' ? 3 : 29;
    return svg(Array.from({ length: count }, (_, i) => {
      const x = 7 + i * (count === 2 ? 110 : 80);
      const y = yBase + (i % 2 ? 12 : 0);
      const index = id === 'battery' ? null : i;
      let extras = '';
      if (id === 'mmwave') extras = `<g transform="translate(${x + 40} ${y - 6})"><path class="sensor-wave" d="M-16 0q16-16 32 0M-24-6q24-24 48 0M-32-12q32-32 64 0"/></g>`;
      if (id === 'pir') extras = `<ellipse class="room-pir-pulse" cx="${x + width / 2}" cy="${y + 33}" rx="49" ry="40"/>`;
      if (id === 'motor') extras = `<g transform="translate(${x + width * .78} ${y + height * .51})"><g data-fan-rotor data-fan="${i}"><circle r="6" fill="none" stroke="#617563" stroke-width="1"/><path d="M0-6V6M-6 0H6" stroke="#b2b69a" stroke-width="1"/></g></g>`;
      const attributes = id === 'pir' ? `data-hw-pir="${i}"` : index !== null ? `data-hw-zone="${i}"` : '';
      const label = id === 'battery' ? `SUPPLY ${pad(i + 1)}` : id === 'mmwave' ? `mmWAVE ${pad(i + 1)}` : id === 'pir' ? `PIR ${pad(i + 1)}` : id === 'led' ? `LIGHT ${pad(i + 1)}` : id === 'motor' ? `FAN ${pad(i + 1)}` : `CHANNEL ${pad(i + 1)}`;
      return `<g ${attributes}>${extras}${part(partName, x, y, width, height)}<text class="hw-unit-label" x="${x + width / 2}" y="${y + height + 16}">${label}</text></g>`;
    }).join(''), `0 0 ${viewWidth} ${viewHeight}`, `${components.find(item => item.id === id).name}, individually labeled engineering illustrations`);
  }

  // A handcrafted 5 × 7 alphabet makes the virtual OLED truly pixel-rendered.
  // This raster is a visual coordinate system, not a module-resolution specification.
  const pixelAlphabet = {
    A:'01110/10001/10001/11111/10001/10001/10001', B:'11110/10001/10001/11110/10001/10001/11110',
    C:'01111/10000/10000/10000/10000/10000/01111', D:'11110/10001/10001/10001/10001/10001/11110',
    E:'11111/10000/10000/11110/10000/10000/11111', F:'11111/10000/10000/11110/10000/10000/10000',
    G:'01111/10000/10000/10111/10001/10001/01111', H:'10001/10001/10001/11111/10001/10001/10001',
    I:'11111/00100/00100/00100/00100/00100/11111', J:'00111/00010/00010/00010/10010/10010/01100',
    K:'10001/10010/10100/11000/10100/10010/10001', L:'10000/10000/10000/10000/10000/10000/11111',
    M:'10001/11011/10101/10101/10001/10001/10001', N:'10001/11001/10101/10011/10001/10001/10001',
    O:'01110/10001/10001/10001/10001/10001/01110', P:'11110/10001/10001/11110/10000/10000/10000',
    Q:'01110/10001/10001/10001/10101/10010/01101', R:'11110/10001/10001/11110/10100/10010/10001',
    S:'01111/10000/10000/01110/00001/00001/11110', T:'11111/00100/00100/00100/00100/00100/00100',
    U:'10001/10001/10001/10001/10001/10001/01110', V:'10001/10001/10001/10001/10001/01010/00100',
    W:'10001/10001/10001/10101/10101/10101/01010', X:'10001/10001/01010/00100/01010/10001/10001',
    Y:'10001/10001/01010/00100/00100/00100/00100', Z:'11111/00001/00010/00100/01000/10000/11111',
    '0':'01110/10001/10011/10101/11001/10001/01110', '1':'00100/01100/00100/00100/00100/00100/01110',
    '2':'01110/10001/00001/00010/00100/01000/11111', '3':'11110/00001/00001/01110/00001/00001/11110',
    '4':'00010/00110/01010/10010/11111/00010/00010', '5':'11111/10000/10000/11110/00001/00001/11110',
    '6':'01110/10000/10000/11110/10001/10001/01110', '7':'11111/00001/00010/00100/01000/01000/01000',
    '8':'01110/10001/10001/01110/10001/10001/01110', '9':'01110/10001/10001/01111/00001/00001/01110',
    '!':'00100/00100/00100/00100/00100/00000/00100', ':':'00000/00100/00100/00000/00100/00100/00000',
    '.':'00000/00000/00000/00000/00000/00100/00100', '-':'00000/00000/00000/11111/00000/00000/00000',
    '/':'00001/00001/00010/00100/01000/10000/10000', '+':'00000/00100/00100/11111/00100/00100/00000'
  };
  let cachedPixelContent = null;
  let cachedPixelPath = '';
  const oledContexts = new WeakMap();

  function oledPixelPath(content) {
    if (content === cachedPixelContent) return cachedPixelPath;
    const lines = content.split('\n');
    const top = Math.max(1,Math.floor((64-((lines.length-1)*9+7))/2));
    const commands = [];
    lines.forEach((line,row) => [...line].forEach((letter,column) => {
      const glyph = pixelAlphabet[letter];
      if (!glyph) return;
      glyph.split('/').forEach((bits,y) => [...bits].forEach((bit,x) => {
        if (bit === '1') commands.push(`M${4+column*6+x} ${top+row*9+y}h1v1h-1Z`);
      }));
    }));
    cachedPixelContent = content;
    cachedPixelPath = commands.join('');
    return cachedPixelPath;
  }

  function renderPixelOled(content) {
    const path = oledPixelPath(content);
    $$('[data-oled-canvas]').forEach(canvas => {
      if (canvas.dataset.content === content) return;
      let context = oledContexts.get(canvas);
      if (!context) {
        context = canvas.getContext('2d');
        if (!context) return;
        oledContexts.set(canvas,context);
      }
      context.clearRect(0,0,128,64);
      context.fillStyle = '#c7ead2';
      context.fill(new Path2D(path));
      canvas.dataset.content = content;
    });
    $$('[data-oled-raster]').forEach(element => attr(element,'d',path));
  }

  // A true cutaway model, projected from world coordinates. No 3D engine or assets.
  function createClassroom() {
    const W = 530, D = 380, H = 210;
    const P = (x, y, z = 0) => [385 + (x - y) * .88, 250 + (x + y) * .43 - z];
    const points = vertices => vertices.map(point => P(...point).map(n => n.toFixed(1)).join(',')).join(' ');
    const poly = (vertices, fill, extra = '') => `<polygon points="${points(vertices)}" fill="${fill}" ${extra}/>`;
    const line = (a, b, color, width = 1, extra = '') => `<path d="M${P(...a).join(' ')}L${P(...b).join(' ')}" stroke="${color}" stroke-width="${width}" fill="none" ${extra}/>`;
    let room = `<ellipse cx="470" cy="650" rx="345" ry="39" fill="#080806" opacity=".22"/>`;
    room += poly([[0,D,0],[W,D,0],[W,D,-16],[0,D,-16]], '#73664f');
    room += poly([[W,0,0],[W,D,0],[W,D,-16],[W,0,-16]], '#817158');
    room += poly([[0,0,0],[W,0,0],[W,D,0],[0,D,0]], '#b1a48b', 'stroke="#c7bda5" stroke-width="1"');
    for (let x = 0; x <= W; x += 53) room += line([x,0,0],[x,D,0], '#756f5c', .55, 'opacity=".26"');
    for (let y = 0; y <= D; y += 38) room += line([0,y,0],[W,y,0], '#756f5c', .55, 'opacity=".26"');
    for (let i = 0; i < 3; i++) {
      const x0 = i * W / 3, x1 = (i + 1) * W / 3;
      room += `<g class="zone-interactive" data-hw-zone="${i}" data-action="inspect-zone" data-zone="${i}" role="button" tabindex="0" aria-pressed="${i === state.selectedZone}" aria-label="Inspect Zone ${pad(i + 1)}"><title>ZONE ${pad(i + 1)} · select to inspect occupancy, timing, and power</title>${poly([[x0,0,1],[x1,0,1],[x1,D,1],[x0,D,1]], 'currentColor', 'class="zone-floor"')}${line([x0 + 11,D,1],[x1 - 11,D,1], 'currentColor', 3, 'class="zone-accent-bar"')}</g>`;
    }
    room += poly([[0,0,0],[0,D,0],[0,D,H],[0,0,H]], '#c5b89c', 'stroke="#dfd1b3" stroke-width="1"');
    room += poly([[0,0,0],[W,0,0],[W,0,H],[0,0,H]], '#b7a585', 'stroke="#d0bd9b" stroke-width="1"');
    room += line([0,0,H],[W,0,H], '#e1d4b6', 5) + line([0,0,H],[0,D,H], '#dfd1b0', 5);
    room += line([0,0,0],[0,D,0], '#978b73', 5) + line([0,0,0],[W,0,0], '#998568', 5);
    // Daylit inset windows on the left wall.
    [[43,130],[156,245]].forEach(([a,b]) => {
      room += poly([[1,a,78],[1,b,78],[1,b,180],[1,a,180]], '#625d4d', 'stroke="#8a8069" stroke-width="4"');
      room += poly([[2,a+4,82],[2,b-4,82],[2,b-4,176],[2,a+4,176]], 'url(#window-glass)');
      room += line([3,(a+b)/2,80],[3,(a+b)/2,177], '#9d9580', 3);
      room += line([3,a+3,129],[3,b-3,129], '#9d9580', 2.5);
      room += poly([[3,a+4,80],[3,b-4,80],[10,b-4,77],[10,a+4,77]], '#d6c7a8');
    });
    // Door, its glazed inset and handle.
    room += poly([[2,280,0],[2,356,0],[2,356,178],[2,280,178]], '#6b5942', 'stroke="#918164" stroke-width="4"');
    room += poly([[3,291,74],[3,346,74],[3,346,157],[3,291,157]], '#92a095', 'stroke="#b1a28a" stroke-width="2"');
    room += line([3,292,67],[3,346,67], '#9a8565', 2);
    const handle = P(5,289,62);
    room += `<circle cx="${handle[0]}" cy="${handle[1]}" r="3" fill="#d3bb80"/>`;
    // Whiteboard set into the right wall.
    room += poly([[167,2,66],[405,2,66],[405,2,166],[167,2,166]], '#6f715e', 'stroke="#6d6b58" stroke-width="3"');
    room += poly([[171,3,69],[401,3,69],[401,3,162],[171,3,162]], '#e2dbc5');
    const wb = P(179,4,151);
    room += `<g transform="matrix(.88 .43 0 1 ${wb[0]} ${wb[1]})" pointer-events="none"><text x="5" y="17" font-family="Arial,sans-serif" font-size="10" fill="#7b8270" letter-spacing="1.7">EVERY WATT COUNTS.</text><path d="M6 30h177" stroke="#b5b39c" stroke-width=".8"/><path d="M10 43h38v20H10Z M74 43h38v20H74Z M139 43h38v20h-38Z" fill="none" stroke="#91a28b" stroke-width="1"/><text x="21" y="57" font-size="7" fill="#85947d">01</text><text x="86" y="57" font-size="7" fill="#85947d">02</text><text x="151" y="57" font-size="7" fill="#85947d">03</text><path d="M49 53h24m40 0h24" stroke="#c3ae82" stroke-width="1"/></g>`;
    const xCenters = [88,265,443];
    xCenters.forEach((x,i) => { const p = P(x,208,1); room += `<g data-hw-zone="${i}" pointer-events="none"><ellipse class="light-floor-pool" cx="${p[0]}" cy="${p[1]}" rx="88" ry="42"/></g>`; });
    const furniture = [];
    function chair(x,y,teacher=false) {
      let c = '';
      [[-15,-12],[15,-12],[-15,12],[15,12]].forEach(([dx,dy]) => { c += line([x+dx,y+dy,23],[x+dx,y+dy,0],'#4e5143',2.2); });
      c += poly([[x-18,y-15,25],[x+18,y-15,25],[x+18,y+16,25],[x-18,y+16,25]], teacher ? '#535649' : '#a16c48','stroke="#725638" stroke-width=".8"');
      c += poly([[x-18,y+15,25],[x+18,y+15,25],[x+18,y+15,55],[x-18,y+15,55]], teacher ? '#515447' : '#906341','stroke="#694f36" stroke-width=".7"');
      c += line([x-13,y+15,48],[x+13,y+15,48],teacher ? '#676d5a' : '#b48a60',1.2);
      return c;
    }
    function desk(x,y,teacher=false) {
      const w = teacher ? 47 : 43, d = teacher ? 26 : 23, z = 53;
      let item = `<g pointer-events="none">`;
      const shadow = P(x,y,0);
      item += `<ellipse cx="${shadow[0]}" cy="${shadow[1]+7}" rx="50" ry="24" fill="#5d5647" opacity=".13"/>`;
      [[-w+5,-d+5],[w-5,-d+5],[-w+5,d-5],[w-5,d-5]].forEach(([dx,dy]) => { item += line([x+dx,y+dy,z-3],[x+dx,y+dy,0],'#4d5145',3); });
      item += poly([[x-w,y+d,z],[x+w,y+d,z],[x+w,y+d,z-6],[x-w,y+d,z-6]], '#9a6d46');
      item += poly([[x+w,y-d,z],[x+w,y+d,z],[x+w,y+d,z-6],[x+w,y-d,z-6]], '#956741');
      item += poly([[x-w,y-d,z],[x+w,y-d,z],[x+w,y+d,z],[x-w,y+d,z]], teacher ? '#b28957' : '#bc8d58','stroke="#d0a776" stroke-width=".7"');
      item += line([x-w+5,y-d+7,z+.3],[x+w-6,y-d+7,z+.3],'#d6ab73',.7,'opacity=".5"');
      if (teacher) {
        item += poly([[x-22,y-2,z+2],[x+17,y-2,z+2],[x+17,y+15,z+2],[x-22,y+15,z+2]], '#747c6b');
        item += poly([[x-22,y-2,z+2],[x+17,y-2,z+2],[x+17,y-2,z+27],[x-22,y-2,z+27]], '#4b5a4f','stroke="#929c87" stroke-width="1"');
        item += line([x-15,y-2,z+19],[x+9,y-2,z+19],'#a1bea1',1);
      } else {
        item += poly([[x-18,y-10,z+1],[x+11,y-10,z+1],[x+11,y+8,z+1],[x-18,y+8,z+1]], '#d9d1b7','stroke="#a29d87" stroke-width=".4"');
        item += line([x-4,y-10,z+1.2],[x-4,y+8,z+1.2],'#b6ad95',.5);
        item += line([x+2,y-7,z+1.2],[x+8,y-7,z+1.2],'#a19e89',.5);
      }
      if (!teacher && y === 213) {
        const index = xCenters.indexOf(x);
        const head = P(x,y+43,80);
        item += `<g data-person-zone="${index}" opacity="${state.zones[index].occupied ? 1 : 0}" class="room-person">${poly([[x-11,y+43,65],[x+11,y+43,65],[x+10,y+43,34],[x-10,y+43,34]],index === 2 ? '#737c68' : '#687e73')}${line([x-10,y+43,62],[x-17,y+22,55],index === 2 ? '#737c68' : '#687e73',4)}${line([x+10,y+43,62],[x+12,y+22,55],index === 2 ? '#737c68' : '#687e73',4)}<ellipse cx="${head[0]}" cy="${head[1]}" rx="7" ry="8.5" fill="#bca281"/><path d="M${head[0]-7} ${head[1]-1}q-1-11 8-10 7 1 6 12l-3-2q-5-1-11 0" fill="#4d4b3e"/></g>`;
      }
      item += chair(x,y+43,teacher) + '</g>';
      return item;
    }
    xCenters.forEach(x => [117,213,303].forEach(y => furniture.push({depth:x+y,markup:desk(x,y)})));
    furniture.push({depth:484,markup:desk(437,47,true)});
    furniture.sort((a,b) => a.depth-b.depth).forEach(object => {room += object.markup;});
    // Each zone has exactly one fixture, one fan and one radar module.
    xCenters.forEach((x,i) => {
      const lightTop = [[x-52,146,200],[x+52,146,200],[x+52,170,200],[x-52,170,200]];
      room += `<g data-hw-zone="${i}" data-action="inspect-zone" data-zone="${i}" role="button" tabindex="0" aria-label="Light ${pad(i+1)}: inspect Zone ${pad(i+1)}"><title>LIGHT ${pad(i+1)}</title>${line([x-34,158,210],[x-34,158,202],'#797565',1)}${line([x+34,158,210],[x+34,158,202],'#797565',1)}${poly(lightTop,'#827b65','stroke="#bcb194" stroke-width="1"')}${poly([[x-48,147,197],[x+48,147,197],[x+48,167,197],[x-48,167,197]],'#f8dd9f','class="room-light-panel"')}${poly([[x-47,149,195],[x+47,149,195],[x+47,166,195],[x-47,166,195]],'#eec47a','class="room-light-panel" filter="url(#soft-glow)" opacity=".26"')}</g>`;
      const fp = P(x,266,159);
      room += `<g data-hw-zone="${i}" data-action="inspect-zone" data-zone="${i}" role="button" tabindex="0" aria-label="Fan ${pad(i+1)}: inspect Zone ${pad(i+1)}"><title>FAN ${pad(i+1)}</title><path d="M${fp[0]} ${fp[1]-24}v24" stroke="#6d7060" stroke-width="3"/><ellipse cx="${fp[0]}" cy="${fp[1]-25}" rx="9" ry="4" fill="#7d806c"/><g transform="matrix(.88 .43 -.88 .43 ${fp[0]} ${fp[1]})">${fanRotor(i,54)}</g><ellipse cx="${fp[0]}" cy="${fp[1]+2}" rx="7" ry="5" fill="#b3ab95"/></g>`;
      const sp = P(x,2,188);
      const controller = P(517,2,121);
      room += `<path class="signal-trace" data-hw-zone="${i}" d="M${sp[0]} ${sp[1]}L${P(x,2,204).join(' ')}L${P(517,2,204).join(' ')}L${controller.join(' ')}"/>`;
      room += `<g data-hw-zone="${i}" pointer-events="none" transform="matrix(.88 .43 0 1 ${sp[0]} ${sp[1]})"><rect x="-13" y="-8" width="26" height="17" rx="2" fill="#3b5b4c" stroke="#93a68b" stroke-width=".5"/><rect x="-1" y="-5" width="11" height="10" fill="#bbbfa4"/><path d="M1-3h6v6H1" fill="none" stroke="#8f8c59" stroke-width=".6"/><circle class="room-sensor-led" cx="-7" cy="4" r="1.5"/><text x="0" y="-13" text-anchor="middle" font-size="5" fill="#7c8068">mmW ${pad(i+1)}</text><path class="sensor-wave" d="M-19 16q19 14 38 0M-29 21q29 25 58 0M-38 25q38 35 76 0"/></g>`;
    });
    [[0,265,188],[508,0,188]].forEach(([x,y,z],i) => {
      const p = P(x,y,z);
      room += `<g data-hw-pir="${i}" transform="translate(${p[0]-8} ${p[1]-9})" pointer-events="none">${part('pir',0,0,19,17)}<ellipse class="room-pir-pulse" cx="9" cy="6" rx="17" ry="11"/></g>`;
    });
    const cp = P(513,2,115);
    room += `<g data-component="esp32" role="button" tabindex="0" aria-label="Inspect classroom EcoSwitch ESP32-S3 controller" transform="matrix(.88 .43 0 1 ${cp[0]-10} ${cp[1]-10})">${part('esp32',0,0,26,42)}<text x="13" y="49" text-anchor="middle" font-size="5" fill="#747c63">ECOSWITCH</text></g>`;
    xCenters.forEach((x,i) => {
      const p = P(x,414,0);
      room += `<g data-hw-zone="${i}" data-action="inspect-zone" data-zone="${i}" role="button" tabindex="0" aria-label="Select Zone ${pad(i+1)}" transform="translate(${p[0]-19} ${p[1]+18})"><rect x="-6" y="-14" width="99" height="34" fill="#171511" fill-opacity=".01"/><text class="zone-number-svg" x="0" y="0">ZONE ${pad(i+1)}</text><text class="zone-state-svg" x="0" y="14" data-state-label="${i}">${state.zones[i].state}</text></g>`;
    });
    $('#classroom-illustration').innerHTML = `<svg class="classroom-svg" viewBox="0 0 960 735" xmlns="http://www.w3.org/2000/svg" role="group" aria-labelledby="classroom-title classroom-desc"><title id="classroom-title">EcoSwitch interactive three-zone classroom</title><desc id="classroom-desc">An isometric architectural cutaway with nine student desks, chairs, windows, a door, whiteboard, teacher desk, three lights, three rotating fans, three radar sensors, two PIR sensors, and the EcoSwitch controller. Select a zone to inspect and control it.</desc>${room}</svg>`;
  }

  function createZoneCards() {
    $('#zone-cards').innerHTML = state.zones.map((zone,i) => `<article class="zone-card ${i === state.selectedZone ? 'is-selected' : ''}" data-hw-zone="${i}"><div class="zone-card-header"><button class="zone-select" data-action="inspect-zone" data-zone="${i}" aria-label="Inspect Zone ${pad(i+1)}"><span>ZONE ${pad(i+1)}</span><span aria-hidden="true">↗</span></button><span class="zone-state-pill"><i></i><span data-state-label="${i}">${zone.state}</span></span></div><div class="zone-card-body"><div class="zone-occupancy"><strong data-occupancy="${i}">${zone.occupied ? 'Occupied' : 'Empty'}</strong><span data-zone-caption="${i}">${zone.occupied ? 'Presence confirmed' : 'Inactivity timer running'}</span><div class="zone-sensor-line"><i></i><span>mmWave ${pad(i+1)}</span><span data-input-label="${i}">${zone.rawPresence ? 'CONFIRMED' : 'NO PRESENCE'}</span></div></div><div class="zone-timer"><svg viewBox="0 0 72 72" aria-hidden="true"><circle class="timer-base" cx="36" cy="36" r="32"/><circle class="timer-path" cx="36" cy="36" r="32" data-timer-ring="${i}"/></svg><div class="zone-timer-center"><strong data-idle="${i}">00:00</strong><span data-timer-caption="${i}">IDLE TIME</span></div></div></div><div class="zone-loads"><span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h10v5H3ZM5 9h6M5 12h6"/></svg>LIGHT ${pad(i+1)} <b data-zone-light="${i}">ON</b></span><span><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2"/><path d="M7 6Q2 1 6 1q4 0 3 5M10 8q6-2 5 2-1 4-5 0M7 10q-2 6-5 3-2-3 3-5"/></svg>FAN ${pad(i+1)} <b data-zone-fan="${i}">ON</b></span><span class="zone-idle-label" data-zone-footer="${i}">Watching the room</span></div></article>`).join('');
    $('#presence-controls').innerHTML = state.zones.map((_,i) => `<button class="control-button" data-action="presence" data-zone="${i}" aria-pressed="${state.zones[i].rawPresence}" aria-label="Toggle simulated mmWave presence in Zone ${pad(i+1)}"><span>PRESENCE ZONE ${pad(i+1)}</span><b class="control-value">${state.zones[i].rawPresence ? 'ON' : 'OFF'}</b></button>`).join('');
    $('#override-controls').innerHTML = state.zones.map((_,i) => `<button class="control-button" data-action="manual" data-zone="${i}" aria-pressed="false" aria-label="Toggle manual power override in Zone ${pad(i+1)}"><span>MANUAL OVERRIDE ${pad(i+1)}</span><b class="control-value">OFF</b></button>`).join('');
    $('#power-bars').innerHTML = state.zones.map((_,i) => `<div class="power-bar-unit" data-hw-zone="${i}" role="meter" aria-label="Zone ${pad(i+1)} simulated power" aria-valuemin="0" aria-valuemax="90" aria-valuenow="90"><div class="power-bar"><i data-power-bar="${i}"></i></div><span>Z${i+1}</span></div>`).join('');
  }

  function createRadarShowcase() {
    $('#radar-demonstration').innerHTML = svg(`<g>${[50,90,130,170,210,250].map(y => `<path d="M15 ${y}h480" class="radar-grid-line"/>`).join('')}${[30,90,150,210,270,330,390,450].map(x => `<path d="M${x} 30v235" class="radar-grid-line"/>`).join('')}</g><path d="M147 144 402 31v224Z" fill="#89c8ce" fill-opacity=".025"/><g data-radar-focus data-hw-zone="1"><g transform="translate(33 112) rotate(-8)">${part('mmwave',0,0,143,107)}</g><path class="radar-main-wave sensor-wave" d="M194 100q39 47 0 94M237 78q68 69 0 138M280 56q98 91 0 182"/><path d="M183 147h187" stroke="#89c8ce" stroke-width=".8" stroke-dasharray="2 7" opacity=".5" class="breadboard-flow"/><g data-radar-target><circle cx="399" cy="78" r="15" class="radar-target"/><path d="M377 106q22-12 44 0l6 50-17 1-1 61h-10l-3-50-3 50h-10l-1-61-13-1Z" class="radar-target"/><path d="M391 143q9 6 18 0" fill="none" stroke="#efa36e" stroke-width=".7"/><circle cx="399" cy="140" r="34" fill="none" stroke="#efa36e" stroke-dasharray="2 5" opacity=".3"/></g></g><text x="370" y="39" font-size="7" fill="#a99b81" letter-spacing="1">HUMAN TARGET</text><text x="222" y="260" font-size="6" fill="#827f6c" letter-spacing="1" text-anchor="middle">CONFIGURED SENSING REGION</text><text x="34" y="94" font-size="7" fill="#89c8ce" data-radar-label>NO CONFIRMED PRESENCE</text>`, '0 0 510 280', '24 GHz radar detection field and a human micro-motion target');
    $('#pir-note-illustration').innerHTML = svg(part('pir',0,0,200,150), '0 0 200 150', 'PIR activity sensor');
  }

  function createComponentExplorer() {
    $('#component-grid').innerHTML = components.map((component,i) => `<article class="component-card ${component.id === 'esp32' ? 'board-card' : ''} card-${component.id} reveal" tabindex="0" role="button" data-component="${component.id}" data-category="${component.category}" aria-label="Inspect ${component.name}" title="${component.purpose}"><div class="component-card-top"><span><i></i> ES–${pad(i+1)}</span><span class="quantity">${component.quantity}</span></div><div class="component-art">${hardwareArtwork(component.id)}</div><h3>${component.name}</h3><span class="component-role">${component.role}</span><p>${component.purpose}</p><div class="component-card-foot"><span>${component.signal}</span><span aria-hidden="true">↗</span></div></article>`).join('');
    $('#console-oled').innerHTML = oledMarkup();
    $('#console-buzzer').innerHTML = svg(buzzerDrawing(), '0 0 200 155', 'Live physical warning buzzer');
  }

  function createArchitecture() {
    $('#architecture-diagram').innerHTML = `<div class="arch-header"><span>SYSTEM ARCHITECTURE</span><span>LIVE LOGICAL STATE</span></div><div class="arch-sensors">${state.zones.map((_,i) => `<div class="arch-sensor" data-hw-zone="${i}"><i></i> mmWave ${pad(i+1)}</div>`).join('')}</div><div class="arch-pirs"><span data-hw-pir="0">PIR 01</span><span data-hw-pir="1">PIR 02</span></div><div class="arch-link"></div><div class="arch-controller">${svg(board(2,0,70,false), '0 0 75 112', 'ESP32-S3 controller board')}<div><strong>ESP32-S3</strong><span>VALIDATE · DEBOUNCE · RESOLVE</span></div></div><div class="arch-link"></div><div class="arch-engine"><strong>OCCUPANCY ENGINE</strong><span>CONFIRMED PRESENCE + ACTIVITY</span></div><div class="arch-link"></div><div class="arch-state-label">ZONE STATE LOGIC</div><div class="arch-zones">${state.zones.map((zone,i) => `<button class="arch-zone" data-hw-zone="${i}" data-action="select-zone" data-zone="${i}"><strong>ZONE ${pad(i+1)}</strong><span class="arch-zone-state" data-state-label="${i}">${zone.state}</span><span class="arch-zone-output">LIGHT <b data-zone-light="${i}">ON</b> / FAN <b data-zone-fan="${i}">ON</b></span></button>`).join('')}</div><div class="arch-link"></div><div class="arch-feedback"><span>OLED <b>LIVE</b></span><b>+</b><span>BUZZER <b data-stat="buzzer">OFF</b></span></div><div class="arch-footer">RAW INPUT → VALIDATION → OCCUPANCY → TIMER → CONTROL</div>`;
  }

  function wireSvg(id, d, label = '', x = 0, y = 0) {
    const wire = wires.find(item => item.id === id);
    return `<g class="wire-group" data-wire="${id}" data-wire-type="${wire.type}" role="button" tabindex="0" aria-label="${wire.from} to ${wire.to}; select wire for details"><title>${wire.from} → ${wire.to}</title><path class="wire-hit" d="${d}"/><path class="wire-base" d="${d}"/><path class="wire-flow" d="${d}"/>${label ? `<text class="wire-label" x="${x}" y="${y}">${label}</text>` : ''}</g>`;
  }

  function createCircuit() {
    let flow = '', devices = '';
    let grid = '';
    for (let x = 20; x < 1250; x += 30) grid += `<path d="M${x} 35v787" class="circuit-svg-bg"/>`;
    for (let y = 40; y < 835; y += 30) grid += `<path d="M15 ${y}h1220" class="circuit-svg-bg"/>`;
    devices += `<rect x="475" y="217" width="250" height="352" rx="7" fill="#242a21" fill-opacity=".55" stroke="#788268" stroke-opacity=".4"/><text class="circuit-node-caption" x="600" y="238" text-anchor="middle">ESP32-S3</text>${board(516,252,171)}<text class="circuit-node-subcaption" x="600" y="551" text-anchor="middle">PROPOSED LOGICAL GPIO MAP</text>`;
    const inputPorts = [4,5,6,7,10,11,12,13];
    inputPorts.forEach((pin,i) => {devices += `<circle cx="475" cy="${263+i*33}" r="3" fill="#a9b7a0"/><text x="483" y="${266+i*33}" fill="#92a88d" font-size="5.5">${pin}</text>`;});
    [14,15,16,17,18,21,8,9,47].forEach((pin,i) => {devices += `<circle cx="725" cy="${263+i*30}" r="3" fill="#a9b7a0"/><text x="709" y="${266+i*30}" fill="#92a88d" font-size="5.5">${pin}</text>`;});
    devices += `<text x="55" y="56" class="circuit-section-label">INPUTS / OCCUPANCY + ACTIVITY</text><text x="826" y="56" class="circuit-section-label">OUTPUTS / ZONE POWER + FEEDBACK</text>`;
    for (let i = 0; i < 3; i++) {
      const y = 83 + i * 121;
      flow += wireSvg(`mm${i+1}`,`M202 ${y+66}H${335+i*24}V${263+i*33}H475`, `GPIO ${4+i}`, 277+i*21, y+61);
      devices += `<g data-hw-zone="${i}">${part('mmwave',70,y,136,102)}<text class="circuit-node-caption" x="78" y="${y+114}">mmWAVE ${pad(i+1)}</text><text class="circuit-node-subcaption" x="79" y="${y+125}">24 GHz PRESENCE</text></g><g data-switch-zone="${i}" data-switch-kind="presence" data-action="presence" data-zone="${i}" role="button" tabindex="0" aria-label="Toggle simulated presence Zone ${pad(i+1)}">${part('switch',220,y+29,69,49)}<text class="circuit-node-subcaption" x="232" y="${y+84}">SIM INPUT ${pad(i+1)}</text></g><path d="M250 ${y+77}v8h-49" stroke="#efa36e" stroke-opacity=".25" stroke-dasharray="2 4" fill="none"/>`;
      const ly = 129 + i * 67;
      flow += wireSvg(`light${i+1}`,`M725 ${263+i*30}H${765+i*15}V${ly}H962`, `GPIO ${14+i}`, 787, ly-6);
      devices += `<g data-hw-zone="${i}">${part(`resistor${state.resistance}`,814,ly-18,83,41)}${part('led',904,ly-37,52,51)}<rect x="977" y="${ly-14}" width="101" height="22" rx="3" fill="#5b5b4a" stroke="#9d947d"/><rect class="room-light-panel" x="982" y="${ly-10}" width="91" height="14" rx="2"/><text class="circuit-node-caption" x="1092" y="${ly-1}">LIGHT ${pad(i+1)}</text><text class="circuit-node-subcaption" x="1093" y="${ly+13}" data-zone-light="${i}">ON</text></g>`;
      const fy = 354 + i * 107;
      flow += wireSvg(`fan${i+1}`,`M725 ${353+i*30}H${751+i*17}V${fy+12}H836`, `GPIO ${[17,18,21][i]}`, 791, fy+7);
      flow += wireSvg(`flyback${i+1}`,`M861 ${fy+27}V${fy-34}H930V${fy+4}H965`, `K → +5V`, 884, fy-44);
      flow += `<path d="M930 ${fy+4}h35M860 ${fy+44}v${709-fy-44}" stroke="#928f7d" stroke-opacity=".28" fill="none"/>`;
      devices += `<g data-hw-zone="${i}">${part('pulldown',785,fy+27,71,36)}${part('mosfet',824,fy-18,75,63)}${part('diode',862,fy-54,79,39)}${part('motor',960,fy-23,98,74)}<text class="circuit-node-subcaption" x="830" y="${fy+61}">G / D / S</text><text class="circuit-node-caption" x="1112" y="${fy+5}">FAN ${pad(i+1)}</text><text class="circuit-node-subcaption" x="1112" y="${fy+19}" data-zone-fan="${i}">ON</text><g transform="translate(1080 ${fy})">${fanRotor(i,22)}</g></g>`;
    }
    [0,1].forEach(i => {
      const x = 82 + i * 147;
      const py = 500;
      flow += wireSvg(`pir${i+1}`, `M${x+61} ${py+49}H${397+i*24}V${362+i*33}H475`, `GPIO ${i ? 10 : 7}`, 334, 543+i*13);
      devices += `<g data-hw-pir="${i}">${part('pir',x,py,104,83)}<ellipse class="room-pir-pulse" cx="${x+52}" cy="${py+35}" rx="53" ry="38"/><text class="circuit-node-caption" x="${x+21}" y="${py+99}">PIR ${pad(i+1)}</text></g>`;
    });
    [0,1,2].forEach(i => {
      const x = 62+i*107;
      flow += wireSvg(`override${i+1}`,`M${x+40} 664H${366+i*24}V${428+i*33}H475`, `GPIO ${11+i}`, 326, 615+i*14);
      devices += `<g data-switch-zone="${i}" data-switch-kind="manual" data-action="manual" data-zone="${i}" role="button" tabindex="0" aria-label="Toggle manual override ${pad(i+1)}">${part('switch',x,624,81,58)}<text class="circuit-node-subcaption" x="${x+9}" y="695">OVERRIDE ${pad(i+1)}</text></g>`;
    });
    flow += wireSvg('sda','M725 443H747V653H854V699','SDA / GPIO 8',753,646);
    flow += wireSvg('scl','M725 473H773V671H874V699','SCL / GPIO 9',790,685);
    flow += wireSvg('buzzer','M725 503H1175V717H1134','GPIO 47',1090,663);
    flow += wireSvg('logic-power','M405 751H484V570H563','REGULATED LOGIC',412,744);
    flow += wireSvg('motor-power','M405 774H930V327','+5 V MOTOR RAIL',722,766);
    flow += wireSvg('ground','M405 795H1210V709H860M605 570V818H1210V795','COMMON GND',995,806);
    flow += wireSvg('assembly','M577 570V690','LOW-VOLTAGE ASSEMBLY',585,648);
    devices += `<g data-component="battery" role="button" tabindex="0" aria-label="Inspect planned power supplies">${part('battery',53,735,57,75)}${part('battery',124,735,57,75)}<text class="circuit-node-subcaption" x="58" y="826">POWER SUPPLY ×2 / PLANNING ONLY</text></g><path d="M172 763h73" stroke="#e6b75d" stroke-opacity=".3" stroke-dasharray="3 5"/><rect x="247" y="731" width="158" height="76" rx="4" fill="#302e22" stroke="#aaa16f" stroke-opacity=".3"/><text class="circuit-node-caption" x="326" y="753" text-anchor="middle">REGULATED SUPPLY</text><text class="circuit-node-subcaption" x="326" y="769" text-anchor="middle">REQUIRED / VERIFY RATINGS</text><text x="326" y="791" text-anchor="middle" fill="#a6aa86" font-size="8">LOGIC + 5 V MOTOR RAILS</text><g data-component="breadboard" role="button" tabindex="0" aria-label="Inspect prototype breadboard">${part('breadboard',490,692,215,119)}<text class="circuit-node-subcaption" x="506" y="836">BREADBOARD + JUMPER WIRES</text></g>${oledSvg(788,704,190)}<text class="circuit-node-caption" x="879" y="854" text-anchor="middle">LIVE I2C OLED</text>${buzzerDrawing(1035,694,125)}<text class="circuit-node-caption" x="1097" y="815" text-anchor="middle">BUZZER</text>`;
    $('#circuit-diagram').innerHTML = `<svg viewBox="0 0 1260 878" xmlns="http://www.w3.org/2000/svg" class="circuit-svg" role="group" aria-label="Complete interactive EcoSwitch logical circuit. Select a wire or GPIO for technical details.">${grid}${flow}${devices}</svg>`;
    const mobileRow = wire => `<button class="mobile-wire" data-wire="${wire.id}"><span>${wire.from}</span><i aria-hidden="true">↓</i><b>${wire.to}</b></button>`;
    $('#circuit-mobile').innerHTML = `<span class="mobile-circuit-label">INPUTS → CONTROLLER</span>${wires.filter(wire => ['presence','pir','manual'].includes(wire.kind)).map(mobileRow).join('')}<div class="arch-link"></div><div class="mobile-circuit-hub"><strong>ESP32-S3</strong><span>VALIDATE → OCCUPANCY → TIMER → CONTROL</span></div><div class="arch-link"></div><span class="mobile-circuit-label">CONTROLLER → OUTPUTS</span>${wires.filter(wire => ['light','motor','data','buzzer'].includes(wire.kind) && wire.id !== 'assembly').map(mobileRow).join('')}<details><summary class="mobile-circuit-label">POWER, PROTECTION & ASSEMBLY ↓</summary><div class="circuit-mobile">${wires.filter(wire => ['supply','ground','flyback'].includes(wire.kind) || wire.id === 'assembly').map(mobileRow).join('')}</div></details>`;
  }

  /* ---------------------------- Simulation engine ------------------------- */
  function logEvent(message, kind = 'data', tag = 'SYSTEM', at = state.elapsed) {
    state.events.push({ id: ++state.eventSequence, at, message, kind, tag });
    state.events.sort((a,b) => a.at - b.at || a.id - b.id);
    if (state.events.length > EVENT_LIMIT) state.events.splice(0, state.events.length - EVENT_LIMIT);
    dirty = true;
  }

  function zoneMode(zone) {
    if (zone.occupied || zone.manual) return 'ACTIVE';
    if (zone.idleSeconds >= SHUTDOWN_AT) return 'SHUTDOWN';
    if (zone.idleSeconds >= WARNING_AT) return 'WARNING';
    return 'IDLE';
  }

  function syncBuzzer() {
    const active = state.zones.some(zone => zone.state === 'WARNING');
    if (active !== state.buzzerActive) {
      state.buzzerActive = active;
      logEvent(active ? 'Buzzer activated — inactivity warning' : 'Buzzer cleared — no warning zones', active ? 'warning' : 'data', 'BUZZER');
      if (active) playBeep();
    }
    dirty = true;
  }

  function commitZone(index, reason = '') {
    const zone = state.zones[index];
    const wasPowered = zone.powered;
    zone.state = zoneMode(zone);
    zone.powered = zone.state !== 'SHUTDOWN';
    if (zone.powered) zone.shutdownSeconds = 0;
    if (wasPowered !== zone.powered) {
      logEvent(`Light ${pad(index + 1)} ${zone.powered ? 'ON' : 'OFF'}${reason ? ` · ${reason}` : ''}`, zone.powered ? 'power' : 'shutdown', zoneName(index).toUpperCase());
      logEvent(`Fan ${pad(index + 1)} ${zone.powered ? 'ON — motor restored' : 'OFF — motor coasting to stop'}`, zone.powered ? 'power' : 'shutdown', zoneName(index).toUpperCase());
    }
    dirty = true;
  }

  // Exact threshold integration, including fast-forward and long frame gaps.
  // The avoided-energy integral only includes time actually commanded OFF.
  function advanceSimulation(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const start = state.elapsed;
    state.elapsed += seconds;
    state.zones.forEach((zone, index) => {
      if (zone.quickOff && !zone.occupied && !zone.manual) return; // driven by processQuickShutdowns
      if (zone.occupied || zone.manual) {
        zone.idleSeconds = 0;
        zone.shutdownSeconds = 0;
        return;
      }
      const before = zone.idleSeconds;
      const after = before + seconds;
      const offDelta = zone.state === 'SHUTDOWN' ? seconds : Math.max(0, after - SHUTDOWN_AT);
      zone.idleSeconds = after;
      zone.offSeconds += offDelta;
      zone.savedWh += offDelta * (state.lightWatts + state.fanWatts) / 3600;
      if (before < WARNING_AT && after >= WARNING_AT) {
        logEvent(`${zoneName(index)} inactivity warning — 10-minute threshold`, 'warning', zoneName(index).toUpperCase(), start + WARNING_AT - before);
      }
      if (before < SHUTDOWN_AT && after >= SHUTDOWN_AT) {
        const at = start + SHUTDOWN_AT - before;
        logEvent(`${zoneName(index)} shutdown — 15-minute inactivity limit`, 'shutdown', zoneName(index).toUpperCase(), at);
        logEvent(`Light ${pad(index + 1)} OFF`, 'shutdown', zoneName(index).toUpperCase(), at);
        logEvent(`Fan ${pad(index + 1)} OFF — motor coasting to stop`, 'shutdown', zoneName(index).toUpperCase(), at);
      }
      zone.shutdownSeconds = after >= SHUTDOWN_AT ? (zone.state === 'SHUTDOWN' ? zone.shutdownSeconds + seconds : after - SHUTDOWN_AT) : 0;
      zone.state = zoneMode(zone);
      zone.powered = zone.state !== 'SHUTDOWN';
    });
    syncBuzzerIfChanged();
  }

  function syncBuzzerIfChanged() {
    if (state.buzzerActive !== state.zones.some(zone => zone.state === 'WARNING')) syncBuzzer();
  }

  function setPresence(index, presence) {
    selectZone(index);
    const zone = state.zones[index];
    if (presence) zone.quickOff = null; // presence returning cancels a running 15 s shutdown
    zone.rawPresence = presence;
    zone.pending = { value: presence, until: performance.now() + VALIDATION_MS };
    zone.sensorPulseUntil = performance.now() + 1500;
    logEvent(`${zoneName(index)} raw presence ${presence ? 'HIGH' : 'LOW'} — validating stable input`, 'data', `mmWAVE ${pad(index + 1)}`);
    dirty = true;
    notify(`${zoneName(index)} · validating ${presence ? 'presence' : 'absence'}…`);
  }

  function validateInputs(now) {
    state.zones.forEach((zone, index) => {
      if (!zone.pending || now < zone.pending.until) return;
      // A new click replaces the pending candidate; a noisy stale input cannot win.
      const confirmed = zone.pending.value;
      zone.pending = null;
      zone.occupied = confirmed;
      zone.idleSeconds = 0;
      logEvent(`${zoneName(index)} ${confirmed ? 'presence confirmed' : 'presence cleared — inactivity begins'}`, 'data', `mmWAVE ${pad(index + 1)}`);
      logEvent(`${zoneName(index)} timer reset${zone.manual ? ' · manual hold remains enabled' : ''}`, 'data', zoneName(index).toUpperCase());
      commitZone(index, confirmed ? 'presence returned' : 'validated input');
      syncBuzzer();
    });
  }

  function triggerPir(index) {
    state.pir[index].pulseUntil = performance.now() + 1600;
    const relevant = index === 0 ? [0, 1] : [1, 2];
    if (!relevant.includes(state.selectedZone)) selectZone(relevant[0]);
    logEvent(`PIR ${pad(index + 1)} movement detected — activity, not continuous presence`, 'data', `PIR ${pad(index + 1)}`);
    relevant.forEach(zoneIndex => {
      state.zones[zoneIndex].idleSeconds = 0;
      state.zones[zoneIndex].quickOff = null;
      logEvent(`${zoneName(zoneIndex)} activity timer reset`, 'data', zoneName(zoneIndex).toUpperCase());
      commitZone(zoneIndex, 'PIR activity grace period');
    });
    syncBuzzer();
    notify(`PIR ${pad(index + 1)} triggered · ${relevant.map(i => `Z${i+1}`).join(' + ')} timers reset`);
  }

  function toggleManual(index) {
    selectZone(index);
    const zone = state.zones[index];
    zone.manual = !zone.manual;
    zone.idleSeconds = 0;
    logEvent(`${zoneName(index)} manual override ${zone.manual ? 'ON — power held, occupancy unchanged' : 'OFF — automatic control resumed'}`, 'power', `OVERRIDE ${pad(index + 1)}`);
    commitZone(index, 'manual override');
    syncBuzzer();
    notify(`${zoneName(index)} · manual power hold ${zone.manual ? 'enabled' : 'released'}`);
  }

  // "Remove presence": presence is cleared immediately (after the normal 350 ms input validation).
  // The zone's lights and fans then switch OFF after QUICK_OFF_SECONDS of real time — not after
  // the 15-simulated-minute timer — whatever the simulation speed. The idle ring still fills
  // 0 → 15:00 over those seconds and the warning shows at the 10 s mark. Clicking again cancels.
  function removePresence(index) {
    selectZone(index);
    const zone = state.zones[index];
    if (zone.quickOff) {
      zone.quickOff = null;
      logEvent(`${zoneName(index)} 15-second shutdown cancelled`, 'data', 'DEMO CONTROL');
      notify(`${zoneName(index)} · shutdown countdown cancelled`);
      dirty = true;
      return;
    }
    if (!zone.rawPresence && !zone.occupied) {
      notify(`${zoneName(index)} is already empty.`);
      return;
    }
    setPresence(index, false);
    zone.quickOff = { remaining: QUICK_OFF_SECONDS };
    logEvent(`${zoneName(index)} presence removed — lights and fans off in ${QUICK_OFF_SECONDS} s`, 'warning', 'DEMO CONTROL');
    notify(`${zoneName(index)} · presence removed · lights and fans turn off in ${QUICK_OFF_SECONDS} seconds`);
    dirty = true;
  }

  function processQuickShutdowns(delta) {
    state.zones.forEach((zone, index) => {
      const quick = zone.quickOff;
      if (!quick) return;
      if (zone.manual) { zone.quickOff = null; return; } // manual hold wins, as for the normal timer
      if (zone.occupied) return;                         // still validating the removed presence
      quick.remaining = Math.max(0, quick.remaining - delta);
      const before = zone.idleSeconds;
      zone.idleSeconds = (1 - quick.remaining / QUICK_OFF_SECONDS) * SHUTDOWN_AT;
      if (before < WARNING_AT && zone.idleSeconds >= WARNING_AT) {
        logEvent(`${zoneName(index)} inactivity warning — shutdown in ${Math.ceil(quick.remaining)} s`, 'warning', zoneName(index).toUpperCase());
      }
      if (quick.remaining === 0) {
        zone.quickOff = null;
        zone.idleSeconds = SHUTDOWN_AT;
        logEvent(`${zoneName(index)} shutdown — ${QUICK_OFF_SECONDS} s after presence removed`, 'shutdown', zoneName(index).toUpperCase());
      }
      commitZone(index, `${QUICK_OFF_SECONDS} s after presence removed`);
    });
    syncBuzzerIfChanged();
  }

  function forceZone(index, mode) {
    const zone = state.zones[index];
    zone.rawPresence = false;
    zone.occupied = false;
    zone.manual = false;
    zone.quickOff = null;
    zone.pending = null;
    zone.idleSeconds = mode === 'WARNING' ? WARNING_AT : SHUTDOWN_AT;
    zone.shutdownSeconds = 0;
    logEvent(`${zoneName(index)} ${mode.toLowerCase()} forced — presence and manual hold cleared`, mode === 'WARNING' ? 'warning' : 'shutdown', 'DEMO CONTROL');
    commitZone(index, 'forced demo state');
    syncBuzzer();
    notify(`${zoneName(index)} · ${mode === 'WARNING' ? 'warning / 5 simulated minutes remaining' : 'power shut down'}`);
  }

  function restoreZone(index) {
    const zone = state.zones[index];
    zone.idleSeconds = 0;
    zone.pending = null;
    // Restoring power deliberately does not invent occupancy.
    zone.rawPresence = zone.occupied;
    logEvent(`${zoneName(index)} power restoration requested — timer reset`, 'power', 'DEMO CONTROL');
    commitZone(index, 'manual restoration');
    syncBuzzer();
    notify(`${zoneName(index)} · power restored${!zone.occupied && !zone.manual ? ' / inactivity grace period restarted' : ''}`);
  }

  function resetSystem() {
    Object.assign(state, {
      zones: initialZones(), selectedZone: 1, elapsed: 0, epoch: Date.now(), running: true,
      speed: 1, lightWatts: 40, fanWatts: 50, pir: [{ pulseUntil: 0 }, { pulseUntil: 0 }],
      buzzerActive: false, events: [], wiring: false, selectedWire: null
    });
    // Preserve audio consent / mute preference, and the hardware explorer filter.
    $('#light-watts').value = '40';
    $('#fan-watts').value = '50';
    $('#energy-error').textContent = '';
    $('#zone-inspector').hidden = true;
    lastFrame = performance.now();
    lastSimulationTick = lastFrame;
    bootEvents('Simulation reset — default assumptions restored');
    dirty = true;
    notify('System reset · Zone 02 is empty. Its independent timer starts now.');
  }

  function bootEvents(message = 'EcoSwitch local simulation initialized') {
    logEvent(message, 'data', 'SYSTEM');
    logEvent('ESP32, five sensors, and OLED online (simulated health)', 'data', 'SYSTEM');
    state.zones.forEach((zone,index) => logEvent(`${zoneName(index)} ${zone.occupied ? 'presence confirmed — outputs ON' : 'empty — independent inactivity timer started'}`, 'data', zoneName(index).toUpperCase()));
  }

  async function toggleAudio() {
    if (state.audioEnabled) {
      state.audioEnabled = false;
      if (audioContext) audioContext.suspend().catch(() => {});
      logEvent('Browser audio disabled; visual buzzer remains live', 'data', 'AUDIO');
      dirty = true;
      return;
    }
    const AudioClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioClass) { notify('This browser does not support Web Audio. Visual buzzer still works.'); return; }
    try {
      if (!audioContext) audioContext = new AudioClass();
      await audioContext.resume();
      state.audioEnabled = audioContext.state === 'running';
      if (!state.audioEnabled) throw new Error('Audio permission not available');
      state.muted = false;
      logEvent('Browser sound enabled by user', 'data', 'AUDIO');
      playBeep(true);
      notify('Sound enabled · short beeps accompany inactivity warnings.');
    } catch (_) {
      state.audioEnabled = false;
      notify('Audio could not start. The visual warning remains fully functional.');
    }
    dirty = true;
  }

  function playBeep(preview = false) {
    if (!state.audioEnabled || state.muted || !audioContext || audioContext.state !== 'running') return;
    if (!preview && !state.buzzerActive) return;
    const t = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(740, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(.065, t + .018);
    gain.gain.linearRampToValueAtTime(0, t + .12);
    gain.gain.setValueAtTime(0, t + .2);
    gain.gain.linearRampToValueAtTime(.045, t + .218);
    gain.gain.linearRampToValueAtTime(0, t + .31);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(t);
    oscillator.stop(t + .33);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    lastBeep = performance.now();
  }

  /* ---------------------------- Rendering --------------------------------- */
  function text(element, value) {
    if (element && element.textContent !== String(value)) element.textContent = String(value);
  }
  function attr(element, name, value) {
    const string = String(value);
    if (element.getAttribute(name) !== string) element.setAttribute(name, string);
  }
  function setText(selector, value) { $$(selector).forEach(element => text(element, value)); }

  function pinLive(pin, now = performance.now()) {
    if (pin.kind === 'presence') return state.zones[pin.zone].rawPresence;
    if (pin.kind === 'pir') return state.pir[pin.pir].pulseUntil > now;
    if (pin.kind === 'manual') return state.zones[pin.zone].manual;
    if (pin.kind === 'light' || pin.kind === 'motor') return state.zones[pin.zone].powered;
    if (pin.kind === 'buzzer') return state.buzzerActive && !state.muted;
    return state.running;
  }
  function wireLive(wire, now) {
    if (wire.pin) return pinLive(pins.find(pin => pin.pin === wire.pin), now);
    if (wire.kind === 'flyback') return !state.zones[wire.zone].powered && state.zones[wire.zone].shutdownSeconds < 120;
    if (wire.id === 'motor-power') return state.zones.some(zone => zone.powered);
    return true;
  }

  function oledState() {
    const warning = state.zones[state.selectedZone].state === 'WARNING' ? state.selectedZone : state.zones.findIndex(zone => zone.state === 'WARNING');
    if (warning !== -1) {
      const zone = state.zones[warning];
      return { mode: 'WARNING', content: `!! WARNING !!\nZONE ${pad(warning + 1)}\n\nIDLE ${clock(zone.idleSeconds)}\nBUZZER ${state.muted ? 'MUTE' : 'ON'}\nOFF IN ${clock(SHUTDOWN_AT - zone.idleSeconds)}` };
    }
    const selected = state.zones[state.selectedZone];
    if (selected.state === 'SHUTDOWN') return { mode: 'SHUTDOWN', content: `ZONE ${pad(state.selectedZone + 1)}\nSHUTDOWN\n\nLIGHT OFF\nFAN OFF\n\nWAITING...` };
    const abbreviations = { ACTIVE: 'ACT', IDLE: 'IDL', WARNING: 'WRN', SHUTDOWN: 'OFF' };
    const activePir = state.pir.findIndex(sensor => sensor.pulseUntil > performance.now());
    const feedback = activePir !== -1 ? `PIR ${pad(activePir+1)} / ACTIVITY` : `BUZ:${state.muted ? 'MUTE' : 'OFF'} / ${state.running ? 'LIVE' : 'PAUSE'}`;
    return { mode: 'OVERVIEW', content: `ECOSWITCH\n${state.zones.map((zone,i) => `Z${i+1} ${zone.manual ? 'MAN' : abbreviations[zone.state]}`).join(' ')}\nL: ${state.zones.map(zone => zone.powered ? 'ON' : '--').join(' ')}\nF: ${state.zones.map(zone => zone.powered ? 'ON' : '--').join(' ')}\nT:${clock(state.elapsed)} / ${state.speed}X\n${feedback}` };
  }

  let renderedEventSequence = -1;
  function renderEvents() {
    if (renderedEventSequence === state.eventSequence) return;
    const root = $('#event-log');
    const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 50;
    const visibleIds = new Set(state.events.map(event => String(event.id)));
    [...root.children].forEach(node => { if (!visibleIds.has(node.dataset.eventId)) node.remove(); });
    state.events.forEach((event,index) => {
      let row = root.querySelector(`[data-event-id="${event.id}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'event-entry';
        row.dataset.eventId = event.id;
        row.dataset.kind = event.kind;
        const date = new Date(state.epoch + event.at * 1000);
        const time = document.createElement('time');
        time.dateTime = date.toISOString();
        time.textContent = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        const tag = document.createElement('span');
        tag.className = 'event-tag';
        tag.textContent = event.tag;
        const message = document.createElement('span');
        message.className = 'event-message';
        message.textContent = event.message;
        row.append(time,tag,message);
      }
      if (root.children[index] !== row) root.insertBefore(row, root.children[index] || null);
    });
    if (atBottom) root.scrollTop = root.scrollHeight;
    text($('#event-count'), state.events.length);
    renderedEventSequence = state.eventSequence;
  }

  function renderInspector() {
    const index = state.selectedZone;
    const zone = state.zones[index];
    text($('#inspector-title'), `ZONE ${pad(index + 1)}`);
    text($('#inspector-state'), zone.state);
    text($('#inspector-occupancy'), `${zone.occupied ? 'OCCUPIED' : 'EMPTY'}${zone.manual ? ' / HOLD' : ''}`);
    text($('#inspector-sensor'), `mmWave ${pad(index + 1)}`);
    text($('#inspector-idle'), clock(zone.idleSeconds));
    text($('#inspector-power'), zone.powered ? 'ON / ON' : 'OFF / OFF');
    text($('#inspector-countdown'), zone.state === 'ACTIVE' ? '—' : zone.state === 'SHUTDOWN' ? 'SHUT DOWN' : zone.quickOff ? `${Math.ceil(zone.quickOff.remaining)} s` : clock(SHUTDOWN_AT - zone.idleSeconds));
    const colors = { ACTIVE: 'var(--active)', IDLE: 'var(--muted)', WARNING: 'var(--warning)', SHUTDOWN: 'var(--danger)' };
    $('#inspector-dot').style.background = colors[zone.state];
    $('#inspector-state').style.color = colors[zone.state];
  }

  function renderPinInfo() {
    const selected = pins.find(pin => pin.pin === state.selectedPin);
    const info = $('#pin-detail');
    if (info && selected) {
      const values = { number: `GPIO ${selected.pin}`, function: selected.fn, device: selected.device, type: selected.type };
      Object.entries(values).forEach(([name,value]) => text($(`[data-pin-field="${name}"]`, info), value));
      text($('#pin-live-readout'), `${pinLive(selected) ? 'ASSERTED' : 'NOT ASSERTED'} · SIMULATED`);
      $$('.pin-buttons [data-pin]').forEach(button => {
        const isSelected = Number(button.dataset.pin) === state.selectedPin;
        button.classList.toggle('is-selected', isSelected);
        attr(button, 'aria-pressed', isSelected);
      });
    }
  }

  function render() {
    const now = performance.now();
    const occupied = state.zones.filter(zone => zone.occupied).length;
    const loads = state.zones.filter(zone => zone.powered).length;
    const warnings = state.zones.filter(zone => zone.state === 'WARNING').length;
    const shutdowns = state.zones.filter(zone => zone.state === 'SHUTDOWN').length;
    const power = loads * (state.lightWatts + state.fanWatts);
    const saved = state.zones.reduce((sum,zone) => sum + zone.savedWh,0);
    const offDuration = state.zones.reduce((sum,zone) => sum + zone.offSeconds,0);
    const stats = {
      occupied, lights: loads, fans: loads, warnings, shutdown: shutdowns,
      power: Number.isInteger(power) ? power : power.toFixed(1), elapsed: clock(state.elapsed),
      saved: saved.toFixed(2), avoided: (saved / 1000).toFixed(5), offDuration: clock(offDuration),
      system: !state.running ? 'PAUSED' : loads === 0 ? 'STANDBY' : 'ACTIVE',
      buzzer: state.buzzerActive ? (state.muted ? 'MUTED' : 'ON') : 'OFF'
    };
    $$('[data-stat]').forEach(element => text(element, stats[element.dataset.stat]));
    attr(document.documentElement, 'data-simulation', state.running ? 'running' : 'paused');
    attr(document.documentElement, 'data-buzzer', state.buzzerActive);
    document.body.classList.toggle('wiring-mode', state.wiring);
    $$('.component-card').forEach(card => {
      const selected = card.dataset.component === state.selectedComponent;
      card.classList.toggle('is-selected',selected);
      attr(card,'aria-pressed',selected);
    });
    $$('[data-radar-focus]').forEach(element => attr(element,'data-hw-zone',state.selectedZone));
    state.zones.forEach((zone,index) => {
      $$(`[data-hw-zone="${index}"]`).forEach(element => {
        attr(element,'data-status',zone.state);
        attr(element,'data-powered',zone.powered);
        attr(element,'data-presence',zone.rawPresence);
        attr(element,'data-manual',zone.manual);
        if (element.classList.contains('zone-interactive')) attr(element,'aria-pressed',index === state.selectedZone);
        if (element.classList.contains('zone-card')) element.classList.toggle('is-selected',index === state.selectedZone);
      });
      setText(`[data-state-label="${index}"]`, zone.state);
      setText(`[data-occupancy="${index}"]`, zone.occupied ? 'Occupied' : 'Empty');
      $$(`[data-person-zone="${index}"]`).forEach(element => attr(element,'opacity',zone.occupied ? 1 : 0));
      setText(`[data-idle="${index}"]`, clock(Math.min(zone.idleSeconds, SHUTDOWN_AT)));
      setText(`[data-timer-caption="${index}"]`, zone.state === 'ACTIVE' ? (zone.manual ? 'MANUAL HOLD' : 'PRESENCE') : zone.state === 'SHUTDOWN' ? 'POWER OFF' : 'IDLE TIME');
      setText(`[data-input-label="${index}"]`, zone.pending ? 'VALIDATING' : zone.rawPresence ? 'CONFIRMED' : 'NO PRESENCE');
      const caption = zone.pending ? 'Validating a stable input…' : zone.manual ? 'Manual power hold enabled' : zone.state === 'ACTIVE' ? 'Presence confirmed' : zone.state === 'WARNING' ? `Power off in ${clock(SHUTDOWN_AT - zone.idleSeconds)}` : zone.state === 'SHUTDOWN' ? 'Waiting for presence' : 'Inactivity timer running';
      setText(`[data-zone-caption="${index}"]`,caption);
      setText(`[data-zone-light="${index}"]`,zone.powered ? 'ON' : 'OFF');
      setText(`[data-zone-fan="${index}"]`,zone.powered ? 'ON' : 'OFF');
      setText(`[data-zone-footer="${index}"]`,zone.manual ? 'Power held manually' : zone.state === 'SHUTDOWN' ? `Off for ${clock(zone.shutdownSeconds)}` : zone.state === 'WARNING' ? `Off in ${clock(SHUTDOWN_AT-zone.idleSeconds)}` : zone.state === 'ACTIVE' ? 'Watching the room' : '15-minute grace period');
      const ring = $(`[data-timer-ring="${index}"]`);
      if (ring) ring.style.setProperty('--timer-offset',(201.1 * (1 - Math.min(1,zone.idleSeconds / SHUTDOWN_AT))).toFixed(2));
      const bar = $(`[data-power-bar="${index}"]`);
      if (bar) {
        bar.style.setProperty('--bar-height',zone.powered && state.lightWatts + state.fanWatts > 0 ? '100%' : '0%');
        attr(bar.closest('.power-bar-unit'),'aria-valuemax',Math.max(1,state.lightWatts+state.fanWatts));
        attr(bar.closest('.power-bar-unit'),'aria-valuenow',zone.powered ? state.lightWatts+state.fanWatts : 0);
      }
    });
    $$('[data-action="presence"], [data-action="manual"]').forEach(button => {
      const zone = state.zones[Number(button.dataset.zone)];
      if (!zone) return;
      const on = button.dataset.action === 'presence' ? zone.rawPresence : zone.manual;
      attr(button,'aria-pressed',on);
      text($('.control-value',button),on ? 'ON' : 'OFF');
    });
    $$('[data-switch-zone]').forEach(element => {
      const zone = state.zones[Number(element.dataset.switchZone)];
      attr(element,'data-switch-on',element.dataset.switchKind === 'manual' ? zone.manual : zone.rawPresence);
    });
    $$('[data-hw-pir], [data-pir-light]').forEach(element => {
      const index = Number(element.dataset.hwPir ?? element.dataset.pirLight);
      attr(element,'data-triggered',state.pir[index].pulseUntil > now);
    });
    $$('[data-buzzer-device]').forEach(element => attr(element,'data-buzzer-active',state.buzzerActive && !state.muted));
    setText('[data-buzzer-label]',state.buzzerActive ? (state.muted ? 'BUZZER MUTED / WARNING' : 'BUZZER ACTIVE') : 'BUZZER STANDBY');
    const removalZone = state.zones[state.selectedZone];
    setText('[data-remove-label]',removalZone.quickOff ? `Cancel · ${Math.max(1,Math.ceil(removalZone.quickOff.remaining))} s` : 'Remove presence');
    $$('[data-action="remove-presence"]').forEach(button => attr(button,'aria-pressed',Boolean(removalZone.quickOff)));
    setText('[data-mute-label]',state.muted ? 'Unmute buzzer' : 'Mute buzzer');
    setText('[data-audio-label]',state.audioEnabled ? 'Disable sound' : 'Enable sound');
    $$('[data-action="mute"]').forEach(button => attr(button,'aria-pressed',state.muted));
    $$('[data-action="audio"]').forEach(button => attr(button,'aria-pressed',state.audioEnabled));
    text($('#sound-note'), !state.audioEnabled ? 'Browser audio is off until you enable it.' : state.muted ? 'Audio is muted. Visual warnings and countdowns remain live.' : 'Sound enabled. Short beeps play during inactivity warnings.');
    $$('[data-action="speed"]').forEach(button => {
      const active = Number(button.dataset.speed) === state.speed;
      button.classList.toggle('is-active',active);
      attr(button,'aria-pressed',active);
    });
    setText('[data-pause-label]',state.running ? 'Pause' : 'Resume');
    setText('[data-pause-icon]',state.running ? 'Ⅱ' : '▷');
    $$('[data-action="pause"]').forEach(button => {
      attr(button,'aria-label',state.running ? 'Pause simulated time; loads remain in their current state' : 'Resume simulation');
      attr(button,'aria-pressed',!state.running);
    });
    $$('[data-action="wiring"]').forEach(button => attr(button,'aria-pressed',state.wiring));
    text($('#wiring-mode-label'),state.wiring ? 'WIRING MODE / SELECT A CONNECTION' : 'LIVE SIGNALS');
    if ($('#target-zone').value !== String(state.selectedZone)) $('#target-zone').value = String(state.selectedZone);
    attr($('#classroom-stage'),'data-focus',state.selectedZone);
    const radarZone = state.zones[state.selectedZone];
    $$('[data-radar-target]').forEach(element => attr(element,'opacity',radarZone.occupied ? '.95' : '.23'));
    setText('[data-radar-label]',radarZone.pending ? 'RAW INPUT / VALIDATING' : radarZone.occupied ? `ZONE ${pad(state.selectedZone + 1)} / PRESENCE CONFIRMED` : `ZONE ${pad(state.selectedZone + 1)} / NO CONFIRMED PRESENCE`);
    const stages = { sense: state.zones.some(zone => zone.rawPresence), interpret: occupied > 0, track: state.zones.some(zone => zone.state === 'IDLE'), warn: warnings > 0, control: shutdowns > 0 };
    $$('[data-pipeline]').forEach(element => element.classList.toggle('is-current',stages[element.dataset.pipeline]));
    $$('[data-wire]').forEach(element => {
      const wire = wires.find(item => item.id === element.dataset.wire);
      if (!wire) return;
      attr(element,'data-live',wireLive(wire,now));
      element.classList.toggle('is-selected',state.selectedWire === wire.id);
    });
    $$('.pin-group').forEach(element => {
      const pin = pins.find(item => item.pin === Number(element.dataset.pin));
      attr(element,'data-live',pinLive(pin,now));
      element.classList.toggle('is-selected',state.selectedPin === pin.pin);
    });
    const oled = oledState();
    renderPixelOled(oled.content);
    $$('[data-oled-screen]').forEach(element => text(element,oled.content));
    $$('[data-oled-unit]').forEach(element => {
      attr(element,'data-oled-status',oled.mode);
      element.classList.toggle('is-refreshing',oled.mode === 'WARNING');
    });
    $$('[data-oled-svg]').forEach(element => {
      if (element.dataset.content === oled.content) return;
      element.innerHTML = oled.content.split('\n').map((line,i) => `<tspan x="33" y="${47+i*10}">${line || ' '}</tspan>`).join('');
      element.dataset.content = oled.content;
    });
    renderInspector();
    renderPinInfo();
    renderEvents();
    dirty = false;
  }

  /* ---------------------------- Inspection -------------------------------- */
  function closeInspector() {
    $('#zone-inspector').hidden = true;
    const selected = $(`.zone-interactive[data-zone="${state.selectedZone}"]`);
    if (selected) selected.focus({preventScroll:true});
  }

  function selectZone(index, inspect = false) {
    state.selectedZone = Math.max(0,Math.min(2,index));
    if (inspect) $('#zone-inspector').hidden = false;
    dirty = true;
    renderInspector();
  }

  function openModal(content, kind, invoker) {
    const modal = $('#technical-modal');
    if (!modal.open) modalInvoker = invoker || document.activeElement;
    modalKind = kind;
    $('#modal-content').innerHTML = content;
    if (!modal.open) modal.showModal();
    document.body.classList.add('modal-open');
    fanNodes = $$('[data-fan-rotor]');
    dirty = true;
    render();
  }

  function openComponent(id, invoker) {
    const component = components.find(item => item.id === id);
    if (!component) return;
    state.selectedComponent = id;
    text($('#modal-eyebrow'),'HARDWARE / TECHNICAL VIEW');
    const specs = [
      ['ROLE',component.role],['INPUT',component.input],['OUTPUT',component.output],
      ['POWER',component.power],['CONNECTIONS',component.connections],['WHAT IT DOES',component.detail]
    ];
    if (id === 'resistor' || id === 'pull-down') specs.unshift(['VALUE',id === 'resistor' ? `${state.resistance} Ω · selectable` : '10 kΩ'],['PURPOSE',id === 'resistor' ? 'LED series current limiting' : 'MOSFET gate pull-down']);
    const pinPanel = id === 'esp32' ? `<section class="pin-explorer" aria-label="Interactive GPIO pin explorer"><div class="panel-topline"><span class="micro-label">17 ASSIGNED GPIO PINS · SELECT TO INSPECT</span><span class="micro-label" id="pin-live-readout">SIMULATED LOGICAL STATE</span></div><div class="pin-buttons">${pins.map(pin => `<button data-pin="${pin.pin}" aria-pressed="${pin.pin === state.selectedPin}">GPIO ${pin.pin}</button>`).join('')}</div><dl class="pin-detail" id="pin-detail"><div><dt>PIN</dt><dd data-pin-field="number"></dd></div><div><dt>FUNCTION</dt><dd data-pin-field="function"></dd></div><div><dt>CONNECTED DEVICE</dt><dd data-pin-field="device"></dd></div><div><dt>SIGNAL TYPE</dt><dd data-pin-field="type"></dd></div></dl></section>` : '';
    const resistorChoice = id === 'resistor' ? `<div class="resistor-choice"><label for="resistance-choice">LED SERIES RESISTANCE</label><select id="resistance-choice"><option value="220" ${state.resistance === 220 ? 'selected' : ''}>220 Ω · red–red–brown</option><option value="330" ${state.resistance === 330 ? 'selected' : ''}>330 Ω · orange–orange–brown</option></select></div>` : '';
    openModal(`<div class="modal-grid"><div class="modal-visual">${hardwareArtwork(id,true)}</div><div class="modal-heading"><span class="micro-label">COMPONENT / ${component.quantity}</span><h2 id="modal-title">${component.name}</h2><p class="modal-description">${component.purpose}</p><dl class="modal-specs">${specs.map(([name,value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl></div>${pinPanel}${resistorChoice}<p class="modal-note">${component.note}</p></div>`,id,invoker);
  }

  function selectPin(number, invoker) {
    if (!pins.some(pin => pin.pin === number)) return;
    state.selectedPin = number;
    state.selectedWire = pins.find(pin => pin.pin === number).wire;
    if (modalKind !== 'esp32' || !$('#technical-modal').open) openComponent('esp32',invoker);
    dirty = true;
    renderPinInfo();
  }

  function openWire(id, invoker) {
    const wire = wires.find(item => item.id === id);
    if (!wire) return;
    state.selectedWire = id;
    state.selectedComponent = 'wires';
    state.wiring = true;
    if (wire.pin) state.selectedPin = wire.pin;
    text($('#modal-eyebrow'),`CONNECTION / ${wire.type.toUpperCase()}`);
    const specs = [['FROM',wire.from],['TO',wire.to],['SIGNAL',wire.signal],['PURPOSE',wire.purpose]];
    openModal(`<div class="wire-modal"><span class="micro-label accent-text">INTERACTIVE WIREFLOW</span><h2 id="modal-title">${wire.pin ? `GPIO ${wire.pin} · ` : ''}${wire.signal}</h2><div class="wire-modal-visual"><div class="wire-endpoint"><small>FROM</small>${wire.from}</div><div class="wire-modal-line" aria-hidden="true"></div><div class="wire-endpoint"><small>TO</small>${wire.to}</div></div><dl class="modal-specs">${specs.map(([name,value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl><p class="modal-note">Proposed demonstration connection. Animated flow represents logical activity, not a measured electrical signal. Verify the exact part interfaces and voltage/current requirements before building.</p></div>`,'wire',invoker);
  }

  function applyComponentFilter(filter) {
    state.componentFilter = filter;
    let count = 0;
    $$('.component-card').forEach(card => {
      const visible = filter === 'all' || card.dataset.category === filter;
      card.hidden = !visible;
      if (visible) count++;
    });
    text($('#component-count'),count);
    $$('[data-action="filter"]').forEach(button => {
      const selected = button.dataset.filter === filter;
      button.classList.toggle('is-active',selected);
      attr(button,'aria-pressed',selected);
    });
  }

  function notify(message) {
    const toast = $('#toast');
    text(toast,message);
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove('is-visible'),2800);
  }

  /* ---------------------------- Input / lifecycle ------------------------- */
  document.addEventListener('click', event => {
    synchronizeClock(performance.now());
    const pinElement = event.target.closest('[data-pin]');
    if (pinElement) { selectPin(Number(pinElement.dataset.pin),pinElement); return; }
    const wireElement = event.target.closest('[data-wire]');
    if (wireElement) { openWire(wireElement.dataset.wire,wireElement); return; }
    const actionElement = event.target.closest('[data-action]');
    if (actionElement) {
      const index = actionElement.dataset.zone === undefined ? state.selectedZone : Number(actionElement.dataset.zone);
      switch (actionElement.dataset.action) {
        case 'presence': setPresence(index,!state.zones[index].rawPresence); break;
        case 'pir': triggerPir(Number(actionElement.dataset.pir)); break;
        case 'manual': toggleManual(index); break;
        case 'inspect-zone': selectZone(index,true); break;
        case 'select-zone': selectZone(index); break;
        case 'close-inspector': closeInspector(); break;
        case 'simulate-selected': setPresence(state.selectedZone,true); break;
        case 'remove-presence': removePresence(state.selectedZone); break;
        case 'warning': forceZone(state.selectedZone,'WARNING'); break;
        case 'restore': restoreZone(state.selectedZone); break;
        case 'reset': resetSystem(); break;
        case 'pause':
          state.running = !state.running;
          logEvent(`Simulation ${state.running ? 'resumed' : 'paused — clock held, load commands unchanged'}`,'data','SYSTEM');
          dirty = true;
          break;
        case 'speed':
          state.speed = Number(actionElement.dataset.speed);
          logEvent(`Simulation speed ${state.speed}× · ${state.speed} simulated minutes per real second`,'data','SYSTEM');
          dirty = true;
          break;
        case 'forward':
          advanceSimulation(300);
          state.zones.forEach(zone => { if (zone.quickOff) zone.quickOff.remaining = Math.max(0, zone.quickOff.remaining - 5); });
          logEvent('Fast-forward: +5 simulated minutes','data','SYSTEM');
          dirty = true;
          notify('Advanced all zone clocks by 5 simulated minutes.');
          break;
        case 'mute':
          state.muted = !state.muted;
          logEvent(`Buzzer audio ${state.muted ? 'muted' : 'unmuted'} — countdown logic unchanged`,'data','BUZZER');
          if (!state.muted && state.buzzerActive) playBeep();
          dirty = true;
          break;
        case 'audio': toggleAudio(); break;
        case 'wiring':
          state.wiring = !state.wiring;
          logEvent(`Wiring visualization ${state.wiring ? 'enabled' : 'disabled'}`,'data','WIREFLOW');
          dirty = true;
          break;
        case 'filter': applyComponentFilter(actionElement.dataset.filter); break;
      }
      if (dirty) { render(); lastRender = performance.now(); }
      return;
    }
    const componentElement = event.target.closest('[data-component]');
    if (componentElement) openComponent(componentElement.dataset.component,componentElement);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#technical-modal').open) {
      if ($('#main-nav').classList.contains('is-open')) {
        $('#main-nav').classList.remove('is-open');
        attr($('#menu-toggle'),'aria-expanded',false);
        attr($('#menu-toggle'),'aria-label','Open navigation');
        $('#menu-toggle').focus();
      } else if (!$('#zone-inspector').hidden) closeInspector();
    }
    if (event.target.matches('input,select,textarea')) return;
    const interactive = event.target.closest('svg [role="button"], .component-card[role="button"]');
    if (interactive && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      interactive.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    }
    if (event.target.closest('.classroom-svg') && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const offset = event.key === 'ArrowLeft' ? -1 : 1;
      const index = (state.selectedZone + offset + 3) % 3;
      selectZone(index);
      $(`.zone-interactive[data-zone="${index}"]`).focus();
    }
  });

  document.addEventListener('input', event => {
    const input = event.target;
    if (!['light-watts','fan-watts'].includes(input.id)) return;
    synchronizeClock(performance.now());
    const watts = Number(input.value);
    if (input.value === '' || !Number.isFinite(watts) || watts < 0 || watts > 2000 || !input.checkValidity()) {
      text($('#energy-error'),'Enter a whole-number assumption from 0 to 2,000 W.');
      return;
    }
    state[input.id === 'light-watts' ? 'lightWatts' : 'fanWatts'] = watts;
    text($('#energy-error'),'');
    dirty = true;
    render();
  });

  document.addEventListener('change', event => {
    if (event.target.id === 'target-zone') { selectZone(Number(event.target.value)); render(); }
    if (['light-watts','fan-watts'].includes(event.target.id) && event.target.checkValidity() && event.target.value !== '') {
      logEvent(`Energy assumption updated: light ${state.lightWatts} W / fan ${state.fanWatts} W per zone`,'data','ENERGY MODEL');
    }
    if (event.target.id === 'resistance-choice') {
      state.resistance = Number(event.target.value);
      $$('.card-resistor use, #modal-content use[href^="#part-resistor"]').forEach(use => use.setAttribute('href',`#part-resistor${state.resistance}`));
      $$('.circuit-svg use[href^="#part-resistor"]').forEach(use => use.setAttribute('href',`#part-resistor${state.resistance}`));
      const valueCell = $$('.modal-specs dt').find(node => node.textContent === 'VALUE');
      if (valueCell) text(valueCell.nextElementSibling,`${state.resistance} Ω · selectable`);
      notify(`${state.resistance} Ω selected · illustration updated. This does not change the energy assumptions.`);
    }
  });

  $('#menu-toggle').addEventListener('click', () => {
    const open = $('#main-nav').classList.toggle('is-open');
    attr($('#menu-toggle'),'aria-expanded',open);
    attr($('#menu-toggle'),'aria-label',open ? 'Close navigation' : 'Open navigation');
  });
  $$('#main-nav a').forEach(link => link.addEventListener('click',() => {
    $('#main-nav').classList.remove('is-open');
    attr($('#menu-toggle'),'aria-expanded',false);
    attr($('#menu-toggle'),'aria-label','Open navigation');
  }));
  $('#modal-close').addEventListener('click',() => $('#technical-modal').close());
  $('#technical-modal').addEventListener('click',event => {
    if (event.target !== $('#technical-modal')) return;
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
  });
  $('#technical-modal').addEventListener('close',() => {
    // Native close events can be queued until paint. Do not clear a newly reopened view.
    if ($('#technical-modal').open) return;
    document.body.classList.remove('modal-open');
    modalKind = null;
    $('#modal-content').replaceChildren();
    fanNodes = $$('[data-fan-rotor]');
    if (modalInvoker && modalInvoker.isConnected && typeof modalInvoker.focus === 'function') modalInvoker.focus({preventScroll:true});
    modalInvoker = null;
  });

  function updateFanModel(delta) {
    // Analytic acceleration/coast model; accurate even on a slow frame or hidden tab.
    state.zones.forEach(zone => {
      const target = zone.powered ? 128 : 0;
      const decay = Math.exp(-2.3 * delta);
      const travel = target * delta + (zone.fanSpeed - target) * (1 - decay) / 2.3;
      zone.fanSpeed = target + (zone.fanSpeed - target) * decay;
      if (zone.fanSpeed < .08) zone.fanSpeed = 0;
      if (!motionPreference.matches) zone.fanAngle = (zone.fanAngle + travel) % 360;
    });
  }

  function synchronizeClock(now) {
    const delta = Math.max(0,(now-lastSimulationTick)/1000);
    lastSimulationTick = now;
    if (state.running) advanceSimulation(delta * 60 * state.speed);
    validateInputs(now);
    if (state.running) processQuickShutdowns(delta);
    updateFanModel(delta);
  }

  function simulationTick() {
    const now = performance.now();
    synchronizeClock(now);
    if (state.buzzerActive && state.running && now-lastBeep > 3200) playBeep();
    if (dirty || now-lastRender >= 200) { render(); lastRender = now; }
  }

  function frame(now) {
    lastFrame = now;
    // rAF is reserved for smooth motor drawing. A single efficient clock owns timing.
    // Extrapolate from the last shared-state update, rather than maintaining UI state.
    if (!motionPreference.matches) {
      const delta = Math.max(0,(now-lastSimulationTick)/1000);
      fanNodes.forEach(node => {
        const zone = state.zones[Number(node.dataset.fan)];
        const target = zone.powered ? 128 : 0;
        const travel = target * delta + (zone.fanSpeed-target) * (1-Math.exp(-2.3*delta))/2.3;
        node.setAttribute('transform',`rotate(${((zone.fanAngle+travel)%360).toFixed(2)})`);
      });
    }
    animationId = requestAnimationFrame(frame);
  }

  function startRevealObserver() {
    if (!('IntersectionObserver' in window) || motionPreference.matches) {
      $$('.reveal').forEach(element => element.classList.add('is-visible'));
      return;
    }
    revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }
    }),{threshold:.07,rootMargin:'0px 0px -18px 0px'});
    $$('.reveal').forEach(element => revealObserver.observe(element));
  }

  window.addEventListener('pagehide',() => {
    cancelAnimationFrame(animationId);
    clearInterval(simulationTimer);
    clearTimeout(toastTimeout);
    $('#toast').classList.remove('is-visible');
    if (audioContext) audioContext.suspend().catch(() => {});
  });
  window.addEventListener('pageshow',event => {
    if (!event.persisted) return;
    state.audioEnabled = false;
    lastFrame = performance.now();
    lastSimulationTick = lastFrame;
    simulationTimer = setInterval(simulationTick,100);
    animationId = requestAnimationFrame(frame);
    dirty = true;
  });

  createSymbolLibrary();
  createClassroom();
  createZoneCards();
  createRadarShowcase();
  createComponentExplorer();
  createArchitecture();
  createCircuit();
  bootEvents();
  fanNodes = $$('[data-fan-rotor]');
  render();
  document.documentElement.classList.add('js');
  startRevealObserver();
  lastFrame = performance.now();
  lastSimulationTick = lastFrame;
  simulationTimer = setInterval(simulationTick,100);
  animationId = requestAnimationFrame(frame);

  // Read-only diagnostic snapshot, useful when inspecting this technical showcase.
  // No public mutation API: all interaction goes through the same visible controls.
  window.EcoSwitch = Object.freeze({ getState: () => JSON.parse(JSON.stringify(state)) });
})();
