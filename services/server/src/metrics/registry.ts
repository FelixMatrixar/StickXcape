/**
 * A small metrics registry that renders the Prometheus text format, so any scraper
 * (Fly.io's managed Prometheus, Grafana Agent) can read /metrics.
 */

interface Metric {
  render(): string;
}

type Labels<L extends string> = Record<L, string>;

function formatNumber(value: number): string {
  if (Number.isFinite(value)) return String(value);
  return Number.isNaN(value) ? 'NaN' : value > 0 ? '+Inf' : '-Inf';
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelText(names: readonly string[], values: readonly string[], extra?: string): string {
  const parts = names.map((name, i) => `${name}="${escapeLabel(values[i] ?? '')}"`);
  if (extra) parts.push(extra);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

function header(name: string, help: string, type: string): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`;
}

export class Counter<L extends string = never> implements Metric {
  private readonly name: string;
  private readonly help: string;
  private readonly labelNames: readonly L[];
  private readonly series = new Map<string, { labels: string[]; value: number }>();

  constructor(name: string, help: string, labelNames: readonly L[] = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  inc(labels: Labels<L> = {} as Labels<L>, by = 1): void {
    const values = this.labelNames.map((name) => labels[name]);
    const key = values.join('\u0000');
    const entry = this.series.get(key);
    if (entry) entry.value += by;
    else this.series.set(key, { labels: values, value: by });
  }

  get(labels: Labels<L> = {} as Labels<L>): number {
    return this.series.get(this.labelNames.map((name) => labels[name]).join('\u0000'))?.value ?? 0;
  }

  /** Sum over every label set whose labels include `match`. */
  sum(match: Partial<Labels<L>> = {}): number {
    let total = 0;
    for (const { labels, value } of this.series.values()) {
      if (this.labelNames.every((name, i) => match[name] === undefined || match[name] === labels[i])) total += value;
    }
    return total;
  }

  render(): string {
    let text = header(this.name, this.help, 'counter');
    if (this.series.size === 0 && this.labelNames.length === 0) text += `${this.name} 0\n`;
    for (const { labels, value } of this.series.values()) {
      text += `${this.name}${labelText(this.labelNames, labels)} ${formatNumber(value)}\n`;
    }
    return text;
  }
}

export class Gauge implements Metric {
  private readonly name: string;
  private readonly help: string;
  private readonly collect: () => number;

  constructor(name: string, help: string, collect: () => number) {
    this.name = name;
    this.help = help;
    this.collect = collect;
  }

  render(): string {
    return `${header(this.name, this.help, 'gauge')}${this.name} ${formatNumber(this.collect())}\n`;
  }
}

export class Histogram<L extends string = never> implements Metric {
  private readonly name: string;
  private readonly help: string;
  private readonly buckets: readonly number[];
  private readonly labelNames: readonly L[];
  private readonly series = new Map<string, { labels: string[]; counts: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, buckets: readonly number[], labelNames: readonly L[] = []) {
    this.name = name;
    this.help = help;
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.labelNames = labelNames;
  }

  observe(value: number, labels: Labels<L> = {} as Labels<L>): void {
    const values = this.labelNames.map((name) => labels[name]);
    const key = values.join('\u0000');
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels: values, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    const index = this.buckets.findIndex((bound) => value <= bound);
    if (index >= 0) entry.counts[index]! += 1;
    entry.sum += value;
    entry.count += 1;
  }

  render(): string {
    let text = header(this.name, this.help, 'histogram');
    for (const { labels, counts, sum, count } of this.series.values()) {
      let cumulative = 0;
      this.buckets.forEach((bound, i) => {
        cumulative += counts[i]!;
        text += `${this.name}_bucket${labelText(this.labelNames, labels, `le="${formatNumber(bound)}"`)} ${cumulative}\n`;
      });
      text += `${this.name}_bucket${labelText(this.labelNames, labels, 'le="+Inf"')} ${count}\n`;
      text += `${this.name}_sum${labelText(this.labelNames, labels)} ${formatNumber(sum)}\n`;
      text += `${this.name}_count${labelText(this.labelNames, labels)} ${count}\n`;
    }
    return text;
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];

  counter<L extends string = never>(name: string, help: string, labelNames: readonly L[] = []): Counter<L> {
    return this.add(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, collect: () => number): Gauge {
    return this.add(new Gauge(name, help, collect));
  }

  histogram<L extends string = never>(name: string, help: string, buckets: readonly number[], labelNames: readonly L[] = []): Histogram<L> {
    return this.add(new Histogram(name, help, buckets, labelNames));
  }

  render(): string {
    return this.metrics.map((metric) => metric.render()).join('');
  }

  private add<M extends Metric>(metric: M): M {
    this.metrics.push(metric);
    return metric;
  }
}
