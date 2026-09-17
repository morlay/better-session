export interface BrowserIdentity {
  readonly userAgent: string;
  readonly vendor: string;
}

const ALTERNATE_IOS_BROWSER = /\b(?:CriOS|FxiOS|EdgiOS|OPiOS|OPT|DuckDuckGo|Brave)(?:\/|\b)/;

export function isSafariBrowser(identity: BrowserIdentity): boolean {
  return (
    identity.vendor === "Apple Computer, Inc." &&
    /\bVersion\/[\d.]+.*\bSafari\/[\d.]+/.test(identity.userAgent) &&
    !ALTERNATE_IOS_BROWSER.test(identity.userAgent)
  );
}

export function repairSafariTextareaLayout(input: HTMLTextAreaElement | null): void {
  if (input === null || input.scrollHeight <= input.clientHeight) return;
  const scrollport = input.closest<HTMLElement>("[data-input-scroll]");
  if (scrollport === null) return;

  const inputHeight = input.style.height;
  input.style.height = `${String(input.clientHeight + 1)}px`;
  void input.offsetHeight;
  input.style.height = inputHeight;
  void input.offsetHeight;

  const scrollportHeight = scrollport.style.height;
  scrollport.style.height = `${String(scrollport.clientHeight + 1)}px`;
  void scrollport.offsetHeight;
  scrollport.style.height = scrollportHeight;
  void scrollport.offsetHeight;
}
