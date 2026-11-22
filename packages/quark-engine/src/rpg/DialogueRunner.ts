export type DialogueFlagValue = boolean | number | string;

export interface DialogueChoice {
  label: string;
  nextId?: string;
  requiresFlag?: string;
  setFlags?: Record<string, DialogueFlagValue>;
}

export interface DialogueNode {
  id: string;
  speaker: string;
  text: string;
  choices?: DialogueChoice[];
  nextId?: string;
  setFlags?: Record<string, DialogueFlagValue>;
}

/**
 * Lightweight branching graph dialogue runner with persistent story flags.
 */
export class DialogueRunner {
  private readonly nodes = new Map<string, DialogueNode>();
  readonly flags: Record<string, DialogueFlagValue> = {};
  currentNode: DialogueNode | null = null;

  constructor(nodes: DialogueNode[], initialFlags: Record<string, DialogueFlagValue> = {}) {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
    Object.assign(this.flags, initialFlags);
  }

  get isActive(): boolean {
    return this.currentNode !== null;
  }

  start(nodeId: string): DialogueNode | null {
    const node = this.nodes.get(nodeId) ?? null;
    this.currentNode = node;
    if (node?.setFlags) {
      Object.assign(this.flags, node.setFlags);
    }
    return node;
  }

  getAvailableChoices(): DialogueChoice[] {
    if (!this.currentNode?.choices) return [];
    return this.currentNode.choices.filter(
      (c) => !c.requiresFlag || Boolean(this.flags[c.requiresFlag])
    );
  }

  choose(visibleChoiceIndex: number): DialogueNode | null {
    const choices = this.getAvailableChoices();
    const picked = choices[visibleChoiceIndex];
    if (!picked) return this.currentNode;
    if (picked.setFlags) {
      Object.assign(this.flags, picked.setFlags);
    }
    return picked.nextId ? this.start(picked.nextId) : this.close();
  }

  advance(): DialogueNode | null {
    if (!this.currentNode) return null;
    if (this.getAvailableChoices().length > 0) {
      return this.choose(0);
    }
    if (this.currentNode.nextId) {
      return this.start(this.currentNode.nextId);
    }
    return this.close();
  }

  close(): null {
    this.currentNode = null;
    return null;
  }
}
