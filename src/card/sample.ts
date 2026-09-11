/**
 * Sample cards for GET /card — lets anyone (including a browser or a health
 * check) see the house design without needing a trade, and proves the render
 * pipeline works in whatever container this is running in.
 */
import { renderScorecard, type ScorecardModel } from './scorecard';

export type SampleKind = 'bull' | 'bear' | 'overall';

export function sampleCard(kind: SampleKind = 'bull'): ScorecardModel {
  if (kind === 'overall') {
    return {
      token: 'OVERALL',
      verdict: 'Bullish',
      pct: '+113%',
      multiple: '1.9X',
      trend: 'up',
      rows: [
        { label: 'Entry MC', value: '$24.1K' },
        { label: 'Exit MC', value: '$61.3K' },
        { label: 'Duration', value: '48m' },
        { label: 'Balance before', value: '2.40 SOL' },
        { label: 'Balance after', value: '5.11 SOL' },
        { label: 'Exit reason', value: 'Wallet sold' },
      ],
      footer: '12 trades : 48m avg hold',
    };
  }
  if (kind === 'bear') {
    return {
      token: '$GRIFT',
      verdict: 'Bearish',
      qualifier: 'Rug',
      pct: '-92%',
      multiple: '0.08X',
      trend: 'down',
      rows: [
        { label: 'Entry MC', value: '$31.4K' },
        { label: 'Exit MC', value: '$2.1K' },
        { label: 'Duration', value: '12m' },
        { label: 'Balance before', value: '2.00 SOL' },
        { label: 'Balance after', value: '0.16 SOL' },
        { label: 'Exit reason', value: 'Rug detected' },
      ],
      footer: 'GRIFT : 12m held',
    };
  }
  return {
    token: '$MOONK',
    verdict: 'Bullish',
    pct: '+417%',
    multiple: '5.2X',
    trend: 'up',
    rows: [
      { label: 'Entry MC', value: '$18.2K' },
      { label: 'Exit MC', value: '$94.1K' },
      { label: 'Duration', value: '2h 14m' },
      { label: 'Balance before', value: '1.20 SOL' },
      { label: 'Balance after', value: '3.85 SOL' },
      { label: 'Exit reason', value: 'Wallet sold' },
    ],
    footer: 'MOONK : 2h 14m held',
  };
}

export async function renderSampleCard(kind: SampleKind = 'bull'): Promise<Buffer> {
  return renderScorecard(sampleCard(kind));
}
