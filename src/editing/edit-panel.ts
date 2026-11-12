import type { UserObject } from './user-objects-store';

export interface EditPanelElements {
  /** Container section toggled between hidden and shown. */
  container: HTMLElement;
  heightInput: HTMLInputElement;
  rotateInput: HTMLInputElement;
  saveButton: HTMLButtonElement;
  deleteButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  /** Paragraph used for validation and live-collision messages. */
  warning: HTMLElement;
}

export interface EditPanelOptions {
  elements: EditPanelElements;
  /** Called with the single changed field once it validates. */
  onChange: (patch: Partial<UserObject>) => void;
  /** Called to export the currently edited object as GeoJSON. */
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * Edits a selected user object: height, colour and rotation, plus delete.
 * Mirrors the DateTimePanel element-injection pattern. Each field edit reports
 * only the field that changed via onChange; validation keeps height positive.
 */
export class EditPanel {
  private readonly elements: EditPanelElements;
  private readonly onChange: (patch: Partial<UserObject>) => void;
  private readonly onSave: () => void;
  private readonly onDelete: () => void;
  private readonly onClose: () => void;

  /** The object currently open in the panel; null while hidden. */
  private current: UserObject | null = null;

  constructor(options: EditPanelOptions) {
    this.elements = options.elements;
    this.onChange = options.onChange;
    this.onSave = options.onSave;
    this.onDelete = options.onDelete;
    this.onClose = options.onClose;
    this.bindEvents();
  }

  private bindEvents(): void {
    this.elements.heightInput.addEventListener('input', () => this.handleHeight());
    this.elements.rotateInput.addEventListener('input', () => this.handleRotation());
    this.elements.saveButton.addEventListener('click', () => this.onSave());
    this.elements.deleteButton.addEventListener('click', () => this.onDelete());
    this.elements.closeButton.addEventListener('click', () => this.onClose());
  }

  /** Fills the fields from `obj` and reveals the panel. */
  open(obj: UserObject): void {
    this.current = obj;
    this.elements.heightInput.value = `${obj.height}`;
    this.elements.rotateInput.value = `${obj.rotationDeg}`;
    this.clearWarning();
    this.elements.container.hidden = false;
  }

  close(): void {
    this.current = null;
    this.clearWarning();
    this.elements.container.hidden = true;
  }

  /**
   * Keeps the panel's notion of the current object in sync after geometry drags,
   * and reflects the live rotation back into the rotate input (unless the field
   * is focused, so typing is never clobbered) so the card tracks map-drag rotation.
   */
  setCurrent(obj: UserObject): void {
    if (this.current && this.current.id === obj.id) {
      this.current = obj;
      if (document.activeElement !== this.elements.rotateInput) {
        this.elements.rotateInput.value = `${obj.rotationDeg}`;
      }
    }
  }

  /** Shows a Ukrainian live-collision message (or clears it when count is 0). */
  showConflictWarning(count: number): void {
    if (count > 0) {
      this.showWarning(`Об’єкт перетинає інші будівлі (${count}).`);
    } else {
      this.clearWarning();
    }
  }

  private handleHeight(): void {
    if (!this.current) {
      return;
    }
    const height = Number(this.elements.heightInput.value);
    if (!Number.isFinite(height) || height <= 0) {
      this.showWarning('Висота має бути більшою за нуль.');
      return;
    }
    this.clearWarning();
    this.current = { ...this.current, height };
    this.onChange({ height });
  }

  private handleRotation(): void {
    if (!this.current) {
      return;
    }
    const rotationDeg = Number(this.elements.rotateInput.value);
    if (!Number.isFinite(rotationDeg)) {
      this.showWarning('Поворот має бути числом.');
      return;
    }
    this.clearWarning();
    this.current = { ...this.current, rotationDeg };
    this.onChange({ rotationDeg });
  }

  private showWarning(message: string): void {
    this.elements.warning.textContent = message;
    this.elements.warning.hidden = false;
  }

  private clearWarning(): void {
    this.elements.warning.textContent = '';
    this.elements.warning.hidden = true;
  }
}
