import React from 'react';
import { CohesionAdvisory, GroupMovePlan, MovePlan } from '../game/movement';

/**
 * The move-order read-out. Armed with M (or Shift+M for a formation move), it
 * answers, before anything is committed: where am I sending this, how far is
 * it, how hard is the going, how much did the road save me, how many movement
 * actions and how much AP does it cost — and if the tile is refused, exactly
 * why. A destination is never silently rejected.
 */
export const MovementPreview: React.FC<{
  unitName: string;
  plan: MovePlan | null;
  advisory: CohesionAdvisory | null;
}> = ({ unitName, plan, advisory }) => {
  if (!plan) {
    return (
      <div className="move-preview" data-testid="move-preview">
        <div className="mp-head">{unitName} — MOVEMENT</div>
        <div className="mp-idle">Hover the map to preview a bound.</div>
      </div>
    );
  }
  return (
    <div className={`move-preview ${plan.ok ? '' : 'invalid'}`} data-testid="move-preview">
      <div className="mp-head">
        MOVE TO GRID <b data-testid="mp-grid">{plan.gridRef}</b>
      </div>
      {plan.ok ? (
        <>
          <div className="mp-line" data-testid="mp-metrics">
            <span>
              Distance <b>{plan.distance}</b>
            </span>
            <span>
              Terrain Cost <b>{plan.terrainCostLabel}</b>
            </span>
            {plan.roadBonus > 0 && (
              <span className="mp-road" data-testid="mp-road-bonus">
                Road Bonus <b>+{plan.roadBonus}</b>
              </span>
            )}
            <span data-testid="mp-actions">
              Movement Actions: <b>{plan.actionsRequired} required</b>
            </span>
            <span>
              <b>{plan.apCost} AP</b>
            </span>
          </div>
          {plan.roadTiles > 0 && (
            <div className="mp-sub">
              {plan.roadTiles} of {plan.path.length} tiles along road — {plan.costWithoutRoads} movement points cross-country
              vs {plan.cost} by road.
            </div>
          )}
          {plan.zocNote && (
            <div className="mp-advisory warn" data-testid="mp-zoc-note">
              ⚠ {plan.zocNote}
            </div>
          )}
        </>
      ) : (
        <div className="mp-reason" data-testid="mp-reason">
          {plan.reason}
        </div>
      )}
      {advisory && (
        <div className={`mp-advisory ${advisory.severity}`} data-testid="mp-advisory">
          ⚠ {advisory.message} <i>You can still proceed.</i>
        </div>
      )}
    </div>
  );
};

/** The same read-out for a grouped Move Formation order. */
export const GroupMovePreview: React.FC<{ plan: GroupMovePlan | null; count: number }> = ({ plan, count }) => {
  if (!plan) {
    return (
      <div className="move-preview" data-testid="group-move-preview">
        <div className="mp-head">FORMATION MOVE — {count} formations</div>
        <div className="mp-idle">Hover the map to preview the formation's advance.</div>
      </div>
    );
  }
  const movers = plan.members.filter((m) => m.ok);
  return (
    <div className={`move-preview ${plan.ok ? '' : 'invalid'}`} data-testid="group-move-preview">
      <div className="mp-head">
        FORMATION MOVE ON GRID <b data-testid="gmp-grid">{plan.targetRef}</b>
      </div>
      {plan.ok ? (
        <>
          <div className="mp-line" data-testid="gmp-metrics">
            <span>
              Formations <b>{movers.length}</b>
            </span>
            <span data-testid="gmp-pace">
              Paced by <b>{plan.pacedBy}</b> ({plan.pace} pts)
            </span>
            <span>
              Movement Actions: <b>1 each</b>
            </span>
            <span data-testid="gmp-ap">
              Total <b>{plan.apCost} AP</b>
            </span>
          </div>
          <div className="mp-sub">{movers.map((m) => `${m.shortName} → ${m.gridRef}`).join(' · ')}</div>
        </>
      ) : (
        <div className="mp-reason" data-testid="gmp-reason">
          {plan.reason}
        </div>
      )}
      {plan.members
        .filter((m) => !m.ok)
        .map((m) => (
          <div className="mp-sub warn" key={m.id}>
            {m.shortName} holds — {m.reason}.
          </div>
        ))}
      {plan.excluded.map((e) => (
        <div className="mp-sub warn" key={e.shortName} data-testid="gmp-excluded">
          {e.shortName} cannot join — {e.reason}.
        </div>
      ))}
      {plan.advisories.map((a) => (
        <div className="mp-advisory warn" key={a} data-testid="gmp-advisory">
          ⚠ {a} <i>You can still proceed.</i>
        </div>
      ))}
    </div>
  );
};
