import type { VendorId } from '../shared/vendors';
import type { CompleteRequest, CompleteResult, Provider, StepRequest, StepResult } from './providers';

/** Sends each request to the provider for its vendor (Anthropic when none is named). `resolve` throws a readable error if the vendor is not set up. */
export class RouterProvider implements Provider {
  constructor(private resolve: (vendor: VendorId) => Provider) {}

  async complete(req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
    return this.resolve(req.vendor ?? 'anthropic').complete(req, signal);
  }

  async step(req: StepRequest, signal?: AbortSignal): Promise<StepResult> {
    const p = this.resolve(req.vendor ?? 'anthropic');
    if (!p.step) throw new Error('This model cannot use tools');
    return p.step(req, signal);
  }
}
