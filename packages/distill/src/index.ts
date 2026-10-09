/**
 * @aoc/distill — the one distillation engine (§11: lessons use "the same distillation engine as
 * playbooks"). A validated model call with a deterministic fallback, and the Approver gate every
 * distilled proposal passes before it binds. Playbooks (mod-registry) and lessons (mod-learning) bring
 * their own prompts, schemas and candidates.
 */
export * from './engine';
export * from './gate';
