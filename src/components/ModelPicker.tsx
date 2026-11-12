import { useEffect, useState } from 'react';
import type { Settings, Tier } from '../../shared/types';
import { isModelName, ModelRef, toolsAllowed, VENDORS, vendorInfo, VendorId } from '../../shared/vendors';
import { act, toast } from '../api';

export const TIER_LABEL: Record<Tier, string> = { fast: 'Fast', standard: 'Standard', top: 'Top' };
const TIERS: Tier[] = ['fast', 'standard', 'top'];

/** "OpenAI · gpt-5", or "Standard (claude-sonnet-5-5)" for an agent that just uses a tier. */
export function modelLabel(a: { tier: Tier; model?: ModelRef }, s: Settings): string {
  if (a.model) return `${vendorInfo(a.model.vendor).label.replace(/ \(.*\)$/, '')} · ${a.model.model}`;
  return `${TIER_LABEL[a.tier]} (${s.models[a.tier]})`;
}

export interface PickerValue { tier: Tier; model: ModelRef | null }

/**
 * Two dropdowns: the vendor, then that vendor's model. Anthropic also offers the three tiers (the old behaviour).
 * Other vendors offer their suggested models, anything a local server reports, and a box to type any model name.
 * `model.model` may be '' while the user is still choosing; callers should not save an empty one.
 */
export function ModelPicker({ settings, value, onChange }: { settings: Settings; value: PickerValue; onChange: (v: PickerValue) => void }) {
  // A vendor with no suggested models (local, custom) is chosen before any model name exists, so remember the choice here
  // until a name is typed and saved. Without this, the dropdown would snap back to Anthropic.
  const [draftVendor, setDraftVendor] = useState<VendorId | null>(null);
  const vendor: VendorId = draftVendor ?? value.model?.vendor ?? 'anthropic';
  const info = vendorInfo(vendor);
  const [found, setFound] = useState<string[]>([]);
  const [typing, setTyping] = useState(false);
  const current = draftVendor && value.model?.vendor !== draftVendor ? '' : value.model?.model ?? '';
  const [name, setName] = useState(current);
  const known = [...info.models, ...found];
  const custom = vendor !== 'anthropic' && (typing || !known.includes(current));

  useEffect(() => { setFound([]); setTyping(false); setName(current); }, [vendor]); // eslint-disable-line react-hooks/exhaustive-deps
  // Typing a name saves after a short pause (and on Enter or leaving the box), not on every keystroke.
  useEffect(() => {
    if (!custom || name.trim() === current) return;
    const t = window.setTimeout(() => { setName(name.trim()); onChange({ tier: value.tier, model: { vendor, model: name.trim() } }); }, 600);
    return () => window.clearTimeout(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const setVendor = (v: VendorId) => {
    if (v === 'anthropic') { setDraftVendor(null); return onChange({ tier: value.tier, model: null }); }
    const first = vendorInfo(v).models[0] ?? '';
    setDraftVendor(v);
    onChange({ tier: value.tier, model: { vendor: v, model: first } });
  };
  const setModel = (m: string) => onChange({ tier: value.tier, model: { vendor, model: m } });
  // A vendor chosen but not yet given a model name is not saved: say so, because the agent keeps its old vendor until then.
  const pending = !!draftVendor && value.model?.vendor !== draftVendor;
  const oldVendor = value.model ? vendorInfo(value.model.vendor).label : 'Anthropic';
  const hasKey = !info.needsKey || !!settings.vendorKeys[vendor];
  const valid = isModelName(current);

  const detect = async () => {
    const list = await act<string[]>('listVendorModels', vendor);
    if (list) { setFound(list); toast(list.length ? `Found ${list.length} model(s).` : 'The server answered but lists no models.'); }
  };

  return (
    <div className="model-picker" data-testid="model-picker">
      <div className="field-row">
        <label>Vendor
          <select value={vendor} data-testid="agent-vendor" onChange={(e) => setVendor(e.target.value as VendorId)}>
            {VENDORS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </label>
        <label>Model
          {vendor === 'anthropic' ? (
            <select data-testid="agent-model" value={value.model ? `m:${value.model.model}` : `t:${value.tier}`}
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith('t:')) onChange({ tier: v.slice(2) as Tier, model: null });
                else onChange({ tier: value.tier, model: { vendor: 'anthropic', model: v.slice(2) } });
              }}>
              <optgroup label="By tier (set in API & Models)">
                {TIERS.map((t) => <option key={t} value={`t:${t}`}>{TIER_LABEL[t]} — {settings.models[t]}</option>)}
              </optgroup>
              <optgroup label="A specific model">
                {info.models.map((m) => <option key={m} value={`m:${m}`}>{m}</option>)}
              </optgroup>
            </select>
          ) : (
            <select data-testid="agent-model" value={custom ? '__other' : current}
              onChange={(e) => {
                if (e.target.value === '__other') { setTyping(true); setName(''); setModel(''); } else { setTyping(false); setModel(e.target.value); }
              }}>
              {known.map((m) => <option key={m} value={m}>{m}</option>)}
              <option value="__other">Other… (type a model name)</option>
            </select>
          )}
        </label>
      </div>
      {custom && (
        <div className="field-row">
          <label>Model name
            <input value={name} data-testid="agent-model-name" placeholder="e.g. llama3.1 or gpt-5-codex"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => { if (name.trim() !== current) setModel(name.trim()); }}
              onKeyDown={(e) => { if (e.key === 'Enter') setModel(name.trim()); }} />
          </label>
          {(vendor === 'local' || vendor === 'custom') && <div className="form-actions end"><button className="btn" type="button" onClick={() => void detect()}>Detect models</button></div>}
        </div>
      )}
      {vendor !== 'anthropic' && (
        <div className="muted small model-note" data-testid="model-note">
          {info.note}{' '}
          {pending
            ? <strong className="warn-text">Not saved yet: this agent still uses {oldVendor} until you enter a model name.</strong>
            : vendor === 'local' ? 'Prompts stay on this computer.'
            : 'This agent\'s prompts, including any project files it reads, are sent to this vendor.'}
          {!hasKey && <> <strong className="warn-text">No key saved for {info.label} yet (Settings, API &amp; Models).</strong></>}
          {(name || current) && !valid && !isModelName(name.trim()) && <> <strong className="warn-text">That model name has characters that are not allowed.</strong></>}
          {valid && (
            <label className="check">
              <input type="checkbox" data-testid="model-tools" checked={toolsAllowed({ vendor, model: current }, settings.modelTools)}
                onChange={(e) => void act('updateSettings', { modelTools: { [current]: e.target.checked } })} />
              Can use tools (read files, ask to edit or run commands). Leave off for models that handle them badly.
            </label>
          )}
        </div>
      )}
    </div>
  );
}
