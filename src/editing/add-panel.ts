export interface AddPanelElements {
  /** Container section toggled between hidden and shown. */
  container: HTMLElement;
  heightInput: HTMLInputElement;
  confirmButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  /** Paragraph used for validation and conflict messages. */
  warning: HTMLElement;
}

export interface AddPanelValues {
  height: number;
}

export interface AddPanelOptions {
  elements: AddPanelElements;
  onConfirm: (values: AddPanelValues) => void;
  onCancel: () => void;
}

const DEFAULT_HEIGHT = '20';

/**
 * Collects the height for a freshly drawn footprint, mirroring the
 * DateTimePanel element-injection pattern. Colour is category-driven, not set
 * here. Validation keeps height positive; showConflictWarning drives the
 * override dialog.
 */
export class AddPanel {
  private readonly elements: AddPanelElements;
  private readonly onConfirm: (values: AddPanelValues) => void;
  private readonly onCancel: () => void;

  private overrideHandler: (() => void) | null = null;
  private overrideCancelHandler: (() => void) | null = null;

  constructor(options: AddPanelOptions) {
    this.elements = options.elements;
    this.onConfirm = options.onConfirm;
    this.onCancel = options.onCancel;
    this.bindEvents();
  }

  private bindEvents(): void {
    this.elements.confirmButton.addEventListener('click', () => this.handleConfirm());
    this.elements.cancelButton.addEventListener('click', () => this.handleCancel());
  }

  /** Resets the form to defaults and reveals it. */
  open(): void {
    this.elements.heightInput.value = DEFAULT_HEIGHT;
    this.clearWarning();
    this.elements.container.hidden = false;
    this.elements.heightInput.focus();
  }

  close(): void {
    this.clearWarning();
    this.elements.container.hidden = true;
  }

  private handleConfirm(): void {
    // If an override dialog is active, the confirm button confirms the override.
    if (this.overrideHandler) {
      const handler = this.overrideHandler;
      this.clearOverride();
      handler();
      return;
    }

    const values = this.readValues();
    if (!values) {
      return;
    }
    this.onConfirm(values);
  }

  private handleCancel(): void {
    if (this.overrideCancelHandler) {
      const handler = this.overrideCancelHandler;
      this.clearOverride();
      handler();
      return;
    }
    this.onCancel();
  }

  /** Validates inputs and shows a Ukrainian message on failure. */
  private readValues(): AddPanelValues | null {
    const height = Number(this.elements.heightInput.value);

    if (!Number.isFinite(height) || height <= 0) {
      this.showWarning('Висота має бути більшою за нуль.');
      return null;
    }

    this.clearWarning();
    return { height };
  }

  /**
   * Reveals the collision override dialog: the confirm button becomes
   * "add anyway" and cancel abandons the placement. Caller supplies both actions.
   */
  showConflictWarning(count: number, onOverride: () => void, onCancel: () => void): void {
    this.overrideHandler = onOverride;
    this.overrideCancelHandler = onCancel;
    this.showWarning(`Фігура перетинає інші будівлі (${count}). Додати попри це?`);
    this.elements.confirmButton.textContent = 'Додати попри це';
  }

  /** Clears the override state, restoring the plain confirm action/label. */
  clearConflictWarning(): void {
    this.clearOverride();
    this.clearWarning();
  }

  private clearOverride(): void {
    this.overrideHandler = null;
    this.overrideCancelHandler = null;
    this.elements.confirmButton.textContent = 'Додати';
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
