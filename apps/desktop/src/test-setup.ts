import "@testing-library/jest-dom/vitest";

// jsdom's PointerEvent constructor doesn't honor MouseEventInit fields
// (clientX, clientY, …), so synthetic React handlers receive `undefined`
// for coordinates and produce NaN math. Replace it with a MouseEvent
// subclass that does honor those fields.
class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  width: number;
  height: number;
  pressure: number;
  tangentialPressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  pointerType: string;
  isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.width = init.width ?? 1;
    this.height = init.height ?? 1;
    this.pressure = init.pressure ?? 0;
    this.tangentialPressure = init.tangentialPressure ?? 0;
    this.tiltX = init.tiltX ?? 0;
    this.tiltY = init.tiltY ?? 0;
    this.twist = init.twist ?? 0;
    this.pointerType = init.pointerType ?? "";
    this.isPrimary = init.isPrimary ?? false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).PointerEvent = PointerEventPolyfill;

// jsdom's Blob predates the arrayBuffer() method that real browsers
// expose. The editor's paste/drop handlers depend on it for byte
// extraction, so polyfill via FileReader.
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    value: function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
    configurable: true,
    writable: true,
  });
}
