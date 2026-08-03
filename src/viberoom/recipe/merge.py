"""JSON merge-patch for recipes: dicts merge recursively, everything else
(including lists — tone-curve points, masks) replaces wholesale."""

from __future__ import annotations


def deep_merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out
