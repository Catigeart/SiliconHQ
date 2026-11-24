import { instanceSettingKeys as routeKeys } from '../route-compatibility.js';
export { sameInstanceRoute } from '../route-compatibility.js';
import {
  workflowRowId,
  builtinRoles,
  defaultRoleFields,
  defaultWorkflowId,
} from '../dist/workflow/rules.js';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function sameDraftValue(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, i) => sameDraftValue(value, b[i]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => sameDraftValue(a[key], b[key]))
  );
}

const projection = (obj, keys) =>
  Object.fromEntries(keys.filter((key) => obj[key] !== undefined).map((key) => [key, obj[key]]));

// A draft is rebased against the latest DSH snapshot before the revision-checked mutation.
// An executor and its model options form one setting, even where the DSH form stores them in separate fields.
export function mergeDraft(base, mine, current, choice = 'mine') {
  const conflicts = [];
  function conflict(path, local, remote) {
    conflicts.push({ path: path.join(' / ') || '整项配置', mine: local, current: remote });
    return choice === 'mine' ? local : remote;
  }
  function merge(before, local, remote, path) {
    if (sameDraftValue(local, before)) return remote;
    if (sameDraftValue(remote, before) || sameDraftValue(local, remote)) return local;
    if (
      Array.isArray(before) &&
      Array.isArray(local) &&
      Array.isArray(remote) &&
      path.at(-1) === 'steps'
    ) {
      const lists = [before, local, remote];
      if (
        lists.every(
          (list) =>
            list.every((row) => row && typeof row.id === 'string') &&
            new Set(list.map((row) => row.id)).size === list.length,
        )
      ) {
        const [original, edited, saved] = lists.map(
          (list) => new Map(list.map((row) => [row.id, row])),
        );
        const result = new Map();
        for (const id of new Set([...original.keys(), ...edited.keys(), ...saved.keys()])) {
          const row = merge(original.get(id), edited.get(id), saved.get(id), [...path, id]);
          if (row !== undefined) result.set(id, row);
        }
        // Choose a common order of the surviving original rows; independently added rows
        // keep their submitted position relative to their nearest surviving neighbours.
        const order = (list) =>
          list
            .map((row) => row.id)
            .filter((id) => original.has(id) && edited.has(id) && saved.has(id) && result.has(id));
        const ids = merge(order(before), order(local), order(remote), [...path, '顺序']).slice();
        for (const list of [remote, local]) {
          const listIds = list.map((row) => row.id);
          for (const [index, id] of listIds.entries()) {
            if (!result.has(id) || ids.includes(id)) continue;
            const next = listIds.slice(index + 1).find((key) => ids.includes(key));
            ids.splice(next === undefined ? ids.length : ids.indexOf(next), 0, id);
          }
        }
        return ids.map((id) => result.get(id));
      }
    }
    if (!record(before) || !record(local) || !record(remote)) return conflict(path, local, remote);

    const keys = new Set([...Object.keys(before), ...Object.keys(local), ...Object.keys(remote)]);
    const result = [];
    const groups = [];
    if (keys.has('backend')) groups.push(['执行者设置', routeKeys]);
    for (const role of builtinRoles)
      if (keys.has(role))
        groups.push([role, ['', 'Llm', 'Model', 'ReasoningEffort'].map((s) => role + s)]);
    for (const [label, members] of groups) {
      const [oldRoute, myRoute, savedRoute] = [before, local, remote].map((v) =>
        projection(v, members),
      );
      const resolved = sameDraftValue(myRoute, oldRoute)
        ? savedRoute
        : sameDraftValue(savedRoute, oldRoute) || sameDraftValue(savedRoute, myRoute)
          ? myRoute
          : conflict([...path, label], myRoute, savedRoute);
      result.push(...Object.entries(resolved));
      for (const member of members) keys.delete(member);
    }
    for (const key of keys) {
      const value = merge(before[key], local[key], remote[key], [...path, key]);
      if (value !== undefined) result.push([key, value]);
    }
    return Object.fromEntries(result);
  }
  return { value: merge(base, mine, current, []), conflicts };
}

// Rebase only the row (or built-in role fields) the editor owns. Keep the rest
// of the snapshot untouched, including unrelated newly added or invalid rows.
export function workflowDraft(edit, latest, id, choice) {
  if (!edit) return { value: latest, conflicts: [] };
  if (id === defaultWorkflowId) {
    const keys = [...Object.keys(defaultRoleFields), 'maxRepairs', 'reviewPolicy'];
    const roles = (config) => projection(config, keys);
    const merged = mergeDraft(roles(edit.base), roles(edit.value), roles(latest), choice);
    return { ...merged, value: { ...latest, ...merged.value } };
  }
  const byId = (config) => config.templates.find((row) => workflowRowId(row) === id);
  const saved = byId(latest);
  const merged = mergeDraft(byId(edit.base), byId(edit.value), saved, choice);
  const replacement = merged.value ? [merged.value] : [];
  const templates = saved
    ? latest.templates.flatMap((row) => (workflowRowId(row) === id ? replacement : [row]))
    : [...latest.templates, ...replacement];
  return { ...merged, value: { ...latest, templates } };
}
