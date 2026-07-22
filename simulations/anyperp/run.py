import json
import random
from dataclasses import asdict
from decimal import Decimal

from .model import MarketModel, Position, PROPOSED_TIERS, RiskTier


def run(seed: int = 42, paths: int = 250, steps: int = 720) -> dict:
    random.seed(seed)
    tier_results = {}
    for tier in RiskTier:
        insolvencies = 0
        max_drawdown = Decimal(0)
        liquidations = 0
        for _ in range(paths):
            model = MarketModel(tier, Decimal("1000000"), Decimal("50000"), Decimal("100"))
            size = model.max_skew_base * Decimal("0.5")
            position = Position(margin=size * Decimal("100") * Decimal("0.8"))
            price = Decimal("100")
            model.trade(position, size, price, Decimal("10"))
            peak = model.marked_lp_nav([position], price)
            path_insolvent = False
            for _step in range(steps):
                shock = Decimal(str(random.gauss(0, 0.012)))
                if random.random() < 0.002:
                    shock += Decimal(str(random.choice([-1, 1]) * random.uniform(0.10, 0.40)))
                price = max(Decimal("0.01"), price * (Decimal(1) + shock))
                nav = model.marked_lp_nav([position], price)
                peak = max(peak, nav)
                max_drawdown = max(max_drawdown, peak - nav)
                if nav + model.insurance + Decimal("25000") < 0 and not path_insolvent:
                    insolvencies += 1
                    path_insolvent = True
                if model.liquidatable(position, price):
                    liquidations += 1
                    equity = position.equity(price, model.cumulative_funding)
                    if equity < 0:
                        waterfall = model.apply_bad_debt_waterfall(-equity, Decimal("25000"))
                        if waterfall["adl_or_socialized"] > 0 and not path_insolvent:
                            insolvencies += 1
                            path_insolvent = True
                    break
        tier_results[tier.value] = {
            "paths": paths,
            "steps": steps,
            "liquidations": liquidations,
            "insolvencies_after_backstop": insolvencies,
            "maximum_lp_drawdown_quote": str(max_drawdown),
            "parameters": {key: str(value) for key, value in asdict(PROPOSED_TIERS[tier]).items()},
        }
    return {"seed": seed, "result_status": "illustrative_not_calibrated", "tiers": tier_results}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
