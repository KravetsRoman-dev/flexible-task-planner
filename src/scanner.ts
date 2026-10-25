export interface Marker { name: string; priority: number }
export interface Settings {
  markers: Marker[];
  include: string;
  exclude: string;
  commentPrefixes: string[];
  scanAnywhere: boolean;
  caseSensitive: boolean;
  autoRefresh: boolean;
  maxFiles: number;
  maxFileKB: number;
  groupTasksByFile: boolean;
}
export interface FoundTask {
  marker: string;
  priority: number;
  description: string;
  line: number; 
  column: number; 
}
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validMarkers(raw: unknown): Marker[] {
  if (!Array.isArray(raw)) { return []; }
  const seen = new Set<string>();
  const out: Marker[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate.name !== 'string' || !Number.isInteger(candidate.priority)) { continue; }
    const name = candidate.name.trim();
    if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(name) || candidate.priority < 1 || candidate.priority > 9) { continue; }
    if (seen.has(name.toUpperCase())) { continue; }
    seen.add(name.toUpperCase());
    out.push({ name, priority: candidate.priority });
  }
  return out;
}

export function scanText(text: string, settings: Pick<Settings, 'markers' | 'scanAnywhere' | 'commentPrefixes' | 'caseSensitive'>): FoundTask[] {
  const result: FoundTask[] = [];
  const markers = validMarkers(settings.markers).sort((a, b) => b.name.length - a.name.length);
  if (!markers.length) { return result; }
  const flags = settings.caseSensitive ? 'u' : 'iu';
  const patterns = markers.map(marker => ({
    marker,
    regex: new RegExp(`(^|[^\\p{L}\\p{N}_-])(${escapeRegex(marker.name)})(?=\\s*(?:[:\\-]|$)|\\s+)`, flags)
  }));
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    let from = 0;
    if (!settings.scanAnywhere) {
      const prefixMatches = settings.commentPrefixes
        .filter(prefix => prefix.length > 0)
        .map(prefix => line.indexOf(prefix))
        .filter(pos => pos >= 0);
      if (!prefixMatches.length) { return; }
      from = Math.min(...prefixMatches) + 1;
    }
    const suffix = line.slice(from);
    for (const { marker, regex } of patterns) {
      const match = regex.exec(suffix);
      if (!match) { continue; }
      const column = from + match.index + match[1].length;
      const tail = suffix.slice(match.index + match[0].length).replace(/^\s*[:\-]\s*/, '').replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
      result.push({ marker: marker.name, priority: marker.priority, description: tail || '(без описания)', line: index, column });
      break; 
    }
  });
  return result;
}
