/** 协作契约被破坏时抛出。`code` 给程序看，`message` 给人看。 */
export class ContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}
