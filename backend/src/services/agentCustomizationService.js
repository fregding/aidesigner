const fs = require('fs');
const path = require('path');
const { PROMPTS_DIR, loadPromptDocument, parseFrontMatter } = require('./promptService');

const INSTRUCTIONS_DIR = path.join(PROMPTS_DIR, 'instructions');
const AGENTS_DIR = path.join(PROMPTS_DIR, 'agents');
const SKILLS_DIR = path.join(PROMPTS_DIR, 'skills');

class AgentCustomizationService {
  static buildPromptBundle({
    basePrompts = [],
    workspace = 'general',
    intent = '',
    agent = '',
    skillNames = [],
    context = {}
  } = {}) {
    const baseSections = basePrompts
      .map(name => loadPromptDocument(name))
      .filter(document => document.body)
      .map(document => ({
        title: `Base Prompt: ${path.basename(document.relativePath)}`,
        content: document.body,
        source: document.relativePath
      }));

    const instructionResult = this.loadInstructions({ workspace, agent, intent });
    const agentProfile = agent ? this.loadAgentProfile(agent) : null;
    const skillResult = this.loadSkills({
      workspace,
      intent,
      skillNames,
      message: context.message || context.userRequest || '',
      draft: context.draft || ''
    });

    const sections = [
      ...baseSections,
      instructionResult.promptSection,
      agentProfile?.promptSection,
      skillResult.promptSection
    ].filter(section => section && section.content);

    const prompt = sections
      .map(section => `## ${section.title}\n${section.content}`.trim())
      .join('\n\n');

    return {
      prompt,
      sections,
      discovery: {
        workspace,
        intent,
        requested_agent: agent || '',
        requested_skills: this.uniqueStrings(skillNames),
        loaded_base_prompts: baseSections.map(section => section.source),
        loaded_instructions: instructionResult.loaded,
        loaded_agent: agentProfile?.metadata || null,
        loaded_skills: skillResult.loaded,
        skipped: [
          ...instructionResult.skipped,
          ...skillResult.skipped,
          ...(agent && !agentProfile ? [`agent:${agent}`] : [])
        ]
      }
    };
  }

  static loadInstructions({ workspace = 'general', agent = '', intent = '' } = {}) {
    const candidates = [
      path.join(INSTRUCTIONS_DIR, 'core.instructions.md'),
      workspace ? path.join(INSTRUCTIONS_DIR, 'workspaces', `${workspace}.instructions.md`) : '',
      agent ? path.join(INSTRUCTIONS_DIR, 'agents', `${agent}.instructions.md`) : ''
    ].filter(Boolean);

    const loaded = [];
    const skipped = [];
    const content = candidates
      .map(filePath => this.loadMarkdownFile(filePath))
      .filter(document => {
        if (!document.body) {
          skipped.push(path.relative(PROMPTS_DIR, document.filePath));
          return false;
        }
        if (!this.matchesMetadata(document.data, { workspace, intent })) {
          skipped.push(path.relative(PROMPTS_DIR, document.filePath));
          return false;
        }
        loaded.push(this.publicMetadata(document));
        return true;
      })
      .map(document => document.body)
      .join('\n\n');

    return {
      loaded,
      skipped,
      promptSection: content
        ? { title: 'Always-On Instructions', content, source: loaded.map(item => item.path).join(', ') }
        : null
    };
  }

  static loadAgentProfile(name) {
    const agentName = this.normalizeName(name);
    if (!agentName) return null;

    const document = this.loadMarkdownFile(path.join(AGENTS_DIR, `${agentName}.agent.md`));
    if (!document.body) return null;

    const metadata = this.publicMetadata(document, { id: agentName, kind: 'agent' });
    return {
      metadata,
      promptSection: {
        title: `Agent Profile: ${metadata.name || agentName}`,
        content: document.body,
        source: metadata.path
      }
    };
  }

  static loadSkills({
    workspace = 'general',
    intent = '',
    skillNames = [],
    message = '',
    draft = ''
  } = {}) {
    const explicitNames = this.uniqueStrings(skillNames).map(name => this.normalizeName(name));
    const discovered = this.discoverSkills();
    const selected = [];
    const skipped = [];
    const selectedIds = new Set();

    const addSkill = (skill, reason) => {
      if (!skill?.body || selectedIds.has(skill.id)) return;
      selectedIds.add(skill.id);
      selected.push({
        ...skill,
        reason
      });
    };

    explicitNames.forEach(name => {
      const skill = discovered.find(item => item.id === name);
      if (skill) addSkill(skill, 'explicit');
      else skipped.push(`skill:${name}`);
    });

    if (!explicitNames.length) {
      discovered.forEach(skill => {
        if (selectedIds.has(skill.id)) return;
        if (this.skillMatches(skill, { workspace, intent, message, draft })) {
          addSkill(skill, 'matched');
        }
      });
    }

    const loaded = selected.map(skill => ({
      id: skill.id,
      name: skill.data.name || skill.id,
      description: skill.data.description || '',
      path: skill.relativePath,
      reason: skill.reason
    }));

    const content = selected
      .map(skill => {
        const title = skill.data.name || skill.id;
        return `### ${title}\n${skill.body}`;
      })
      .join('\n\n');

    return {
      loaded,
      skipped,
      promptSection: content
        ? { title: 'Loaded Skills', content, source: loaded.map(item => item.path).join(', ') }
        : null
    };
  }

  static discoverSkills() {
    if (!fs.existsSync(SKILLS_DIR)) return [];

    const skills = [];
    fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).forEach(entry => {
      if (entry.isDirectory()) {
        const filePath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
        const document = this.loadMarkdownFile(filePath);
        if (!document.body) return;
        skills.push({
          id: this.normalizeName(document.data.id || document.data.name || entry.name),
          data: document.data,
          body: document.body,
          filePath,
          relativePath: path.relative(PROMPTS_DIR, filePath)
        });
        return;
      }

      if (entry.isFile() && entry.name.endsWith('.txt')) {
        const filePath = path.join(SKILLS_DIR, entry.name);
        const body = fs.readFileSync(filePath, 'utf-8').trim();
        if (!body) return;
        const id = this.normalizeName(path.basename(entry.name, '.txt'));
        skills.push({
          id,
          data: {
            id,
            name: id,
            description: 'Legacy prompt skill',
            legacy: true
          },
          body,
          filePath,
          relativePath: path.relative(PROMPTS_DIR, filePath)
        });
      }
    });

    return skills.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  static skillMatches(skill, { workspace = 'general', intent = '', message = '', draft = '' } = {}) {
    const data = skill.data || {};
    if (!this.matchesMetadata(data, { workspace, intent })) return false;

    const tokens = this.uniqueStrings([
      data.trigger,
      data.triggers,
      data.keywords,
      data.use_when,
      data.description
    ]).flatMap(item => String(item).split(/[,\s，、|]+/).map(token => token.trim()).filter(Boolean));

    if (!tokens.length) return false;
    const text = `${message || ''}\n${draft || ''}\n${intent || ''}\n${workspace || ''}`.toLowerCase();
    return tokens.some(token => token && text.includes(String(token).toLowerCase()));
  }

  static matchesMetadata(data = {}, { workspace = 'general', intent = '' } = {}) {
    const workspaces = this.uniqueStrings(data.workspace || data.workspaces);
    if (workspaces.length && !workspaces.includes(workspace) && !workspaces.includes('*')) {
      return false;
    }

    const intents = this.uniqueStrings(data.intent || data.intents);
    if (intents.length && intent && !intents.includes(intent) && !intents.includes('*')) {
      return false;
    }

    return true;
  }

  static loadMarkdownFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { filePath, data: {}, body: '' };
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseFrontMatter(raw);
    return {
      filePath,
      data: parsed.data,
      body: parsed.body.trim()
    };
  }

  static publicMetadata(document, fallback = {}) {
    const data = document.data || {};
    return {
      ...fallback,
      id: this.normalizeName(data.id || fallback.id || data.name || path.basename(document.filePath || '', path.extname(document.filePath || ''))),
      name: data.name || fallback.name || '',
      description: data.description || fallback.description || '',
      path: path.relative(PROMPTS_DIR, document.filePath || '')
    };
  }

  static uniqueStrings(value) {
    const list = Array.isArray(value) ? value : [value];
    const expanded = list.flatMap(item => {
      if (Array.isArray(item)) return item;
      if (typeof item === 'string' && item.includes(',')) return item.split(',');
      return [item];
    });
    return [...new Set(expanded
      .map(item => String(item || '').trim())
      .filter(Boolean))];
  }

  static normalizeName(name = '') {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}

module.exports = AgentCustomizationService;
