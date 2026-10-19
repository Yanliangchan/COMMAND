import { useState } from 'react';
import { BOARD } from '../map';
import { findSet, isValidSet } from '../engine';
import { Card, DIS_TRADE_BONUS, FactionId, MAX_HAND, tradeValue } from '../types';
import { KindIcon } from './Glyphs';

const KIND_LABEL = { LAND: 'Land', SEA: 'Sea', AIR: 'Air', WILD: 'Wild' } as const;

export function AssetCard({ card, selected, onClick }: { card: Card; selected?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={`io-card io-card-${card.kind.toLowerCase()}${selected ? ' io-card-selected' : ''}`} onClick={onClick}>
      <span className="io-card-kind">{KIND_LABEL[card.kind]}</span>
      <span className="io-card-icon">
        <KindIcon kind={card.kind} size={40} />
      </span>
      <span className="io-card-asset">{card.asset}</span>
      <span className="io-card-region">{card.region ? BOARD.byId[card.region].name : 'Matches any set'}</span>
    </button>
  );
}

interface Props {
  cards: Card[];
  faction: FactionId;
  tradesDone: number;
  canTrade: boolean;
  onTrade: (ids: number[]) => void;
  onClose: () => void;
}

export function HandDrawer({ cards, faction, tradesDone, canTrade, onTrade, onClose }: Props) {
  const [picked, setPicked] = useState<number[]>([]);
  const chosen = cards.filter((c) => picked.includes(c.id));
  const valid = isValidSet(chosen);
  const value = tradeValue(tradesDone) + (faction === 'DIS' ? DIS_TRADE_BONUS : 0);
  const suggestion = findSet(cards);

  const toggle = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 3 ? [...p, id] : p));

  return (
    <div className="io-modal-backdrop" onClick={onClose}>
      <div className="io-hand" onClick={(e) => e.stopPropagation()}>
        <div className="io-hand-head">
          <div>
            <h3>Asset Cards</h3>
            <p>
              Trade three of a kind, or one of each, for <b>{value} troops</b>. Every trade by anyone raises the next one.
              {cards.length >= MAX_HAND && <span className="io-warn"> You hold {cards.length} — you must trade.</span>}
            </p>
          </div>
          <button className="io-icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {cards.length ? (
          <div className="io-hand-cards">
            {cards.map((c) => (
              <AssetCard key={c.id} card={c} selected={picked.includes(c.id)} onClick={() => toggle(c.id)} />
            ))}
          </div>
        ) : (
          <p className="io-empty">No cards yet. Capture at least one region in a turn to earn one.</p>
        )}
        <div className="io-hand-actions">
          {suggestion && (
            <button className="io-btn io-btn-ghost" onClick={() => setPicked(suggestion.map((c) => c.id))}>
              Pick a set for me
            </button>
          )}
          <button
            className="io-btn io-btn-primary"
            disabled={!valid || !canTrade}
            onClick={() => {
              onTrade(picked);
              setPicked([]);
            }}
          >
            {canTrade ? `Trade for ${value} troops` : 'Trade during Mobilise'}
          </button>
        </div>
      </div>
    </div>
  );
}
