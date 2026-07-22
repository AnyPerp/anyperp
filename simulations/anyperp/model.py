"""Executable accounting reference for AnyPerp.

All values are Decimal quote or base units, not binary floats. Solidity uses WAD
integers with liabilities rounded up and credits rounded down; tests compare the
same formulas at WAD precision.
"""

from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN, ROUND_UP, getcontext
from enum import Enum

getcontext().prec = 60
BPS = Decimal(10_000)
ZERO = Decimal(0)


class RiskTier(str, Enum):
    BLUE_CHIP = "blue_chip"
    ESTABLISHED = "established"
    EMERGING = "emerging"
    EXPERIMENTAL = "experimental"


@dataclass(frozen=True)
class RiskParameters:
    initial_margin_bps: Decimal
    maintenance_margin_bps: Decimal
    max_leverage: Decimal
    max_oi_to_liquidity: Decimal
    max_skew_to_liquidity: Decimal
    max_impact_bps: Decimal
    liquidation_penalty_bps: Decimal
    max_utilization_bps: Decimal
    base_spread_bps: Decimal
    long_payout_stress_bps: Decimal
    short_payout_stress_bps: Decimal


PROPOSED_TIERS = {
    RiskTier.BLUE_CHIP: RiskParameters(Decimal(1000), Decimal(600), Decimal(10), Decimal("1.0"), Decimal("0.35"), Decimal(100), Decimal(100), Decimal(8000), Decimal(5), Decimal(20000), Decimal(10000)),
    RiskTier.ESTABLISHED: RiskParameters(Decimal(2000), Decimal(1200), Decimal(5), Decimal("0.65"), Decimal("0.25"), Decimal(250), Decimal(250), Decimal(7000), Decimal(10), Decimal(30000), Decimal(10000)),
    RiskTier.EMERGING: RiskParameters(Decimal(4000), Decimal(2500), Decimal("2.5"), Decimal("0.35"), Decimal("0.15"), Decimal(500), Decimal(500), Decimal(5500), Decimal(20), Decimal(50000), Decimal(10000)),
    RiskTier.EXPERIMENTAL: RiskParameters(Decimal(6667), Decimal(5000), Decimal("1.5"), Decimal("0.15"), Decimal("0.08"), Decimal(1000), Decimal(800), Decimal(3500), Decimal(50), Decimal(90000), Decimal(10000)),
}


@dataclass
class Position:
    size_base: Decimal = ZERO
    entry_price: Decimal = ZERO
    margin: Decimal = ZERO
    funding_checkpoint: Decimal = ZERO

    def notional(self, price: Decimal) -> Decimal:
        return abs(self.size_base) * price

    def unrealized_pnl(self, mark_price: Decimal) -> Decimal:
        return self.size_base * (mark_price - self.entry_price)

    def equity(self, mark_price: Decimal, cumulative_funding: Decimal) -> Decimal:
        funding = self.size_base * (cumulative_funding - self.funding_checkpoint)
        return self.margin + self.unrealized_pnl(mark_price) - funding


@dataclass(frozen=True)
class TradeResult:
    execution_price: Decimal
    realized_pnl: Decimal
    fee: Decimal
    new_size: Decimal
    new_entry_price: Decimal
    new_margin: Decimal


class MarketModel:
    def __init__(self, tier: RiskTier, liquidity: Decimal, insurance: Decimal, reference_price: Decimal = Decimal("100")):
        self.risk = PROPOSED_TIERS[tier]
        self.liquidity = Decimal(liquidity)
        self.insurance = Decimal(insurance)
        self.long_oi_base = ZERO
        self.short_oi_base = ZERO
        self.cumulative_funding = ZERO
        self.max_skew_base = self.liquidity * self.risk.max_skew_to_liquidity / Decimal(reference_price)

    @property
    def skew_base(self) -> Decimal:
        return self.long_oi_base - self.short_oi_base

    def execution_price(self, index_price: Decimal, size_delta: Decimal) -> Decimal:
        if self.liquidity <= 0:
            raise ValueError("liquidity must be positive")
        skew_scale_base = self.max_skew_base
        average_skew = self.skew_base + size_delta / Decimal(2)
        impact_bps = average_skew / skew_scale_base * self.risk.max_impact_bps
        impact_bps = max(-self.risk.max_impact_bps, min(self.risk.max_impact_bps, impact_bps))
        impact_bps += self.risk.base_spread_bps if size_delta > 0 else -self.risk.base_spread_bps
        return index_price * (BPS + impact_bps) / BPS

    def required_reserve(self, index_price: Decimal) -> Decimal:
        long_loss = self.long_oi_base * index_price * self.risk.long_payout_stress_bps / BPS
        short_loss = self.short_oi_base * index_price * self.risk.short_payout_stress_bps / BPS
        return max(long_loss, short_loss)

    def utilization_limit(self) -> Decimal:
        return self.liquidity * self.risk.max_utilization_bps / BPS

    def marked_lp_nav(self, positions: list[Position], mark_price: Decimal) -> Decimal:
        """LP NAV after recognizing payable trader profit and collectible loss.

        Positive trader PnL is a full LP liability. Negative trader PnL is an LP
        asset only up to the trader's remaining margin; this avoids the old model's
        false zero-drawdown result.
        """
        nav = self.liquidity
        for position in positions:
            pnl = position.unrealized_pnl(mark_price)
            if pnl > 0:
                nav -= pnl
            elif pnl < 0:
                nav += min(-pnl, position.margin)
        return nav

    def trade(self, position: Position, size_delta: Decimal, index_price: Decimal, fee_bps: Decimal) -> TradeResult:
        size_delta = Decimal(size_delta)
        index_price = Decimal(index_price)
        if size_delta == 0 or index_price <= 0:
            raise ValueError("invalid trade")
        price = self.execution_price(index_price, size_delta)
        old_size = position.size_base
        new_size = old_size + size_delta
        realized = ZERO
        entry = position.entry_price

        if old_size == 0 or (old_size > 0) == (size_delta > 0):
            entry = (abs(old_size) * entry + abs(size_delta) * price) / abs(new_size)
        else:
            closed = min(abs(old_size), abs(size_delta))
            realized = closed * (price - entry) * (Decimal(1) if old_size > 0 else Decimal(-1))
            if new_size == 0:
                entry = ZERO
            elif (old_size > 0) != (new_size > 0):
                entry = price

        fee = (abs(size_delta) * price * fee_bps / BPS).quantize(Decimal("1e-18"), rounding=ROUND_UP)
        margin = position.margin + realized - fee
        if margin < 0:
            raise ValueError("trade creates negative margin")

        old_long = max(old_size, ZERO)
        old_short = max(-old_size, ZERO)
        new_long = max(new_size, ZERO)
        new_short = max(-new_size, ZERO)
        self.long_oi_base += new_long - old_long
        self.short_oi_base += new_short - old_short
        self.liquidity -= realized
        self.liquidity += fee

        position.size_base = new_size
        position.entry_price = entry
        position.margin = margin
        position.funding_checkpoint = self.cumulative_funding
        return TradeResult(price, realized, fee, new_size, entry, margin)

    def accrue_funding(self, index_price: Decimal, elapsed_seconds: int, velocity_per_second: Decimal, cap_per_second: Decimal) -> Decimal:
        if elapsed_seconds < 0:
            raise ValueError("elapsed time cannot be negative")
        skew_ratio = self.skew_base / max(self.max_skew_base, Decimal("1e-18"))
        rate = skew_ratio * Decimal(velocity_per_second) * index_price
        rate = max(-Decimal(cap_per_second), min(Decimal(cap_per_second), rate))
        self.cumulative_funding += rate * Decimal(elapsed_seconds)
        return rate

    def liquidatable(self, position: Position, mark_price: Decimal) -> bool:
        notional = position.notional(mark_price)
        maintenance = notional * self.risk.maintenance_margin_bps / BPS
        return position.equity(mark_price, self.cumulative_funding) < maintenance

    def liquidation_price_approx(self, position: Position) -> Decimal:
        if position.size_base == 0:
            raise ValueError("position is empty")
        mmr = self.risk.maintenance_margin_bps / BPS
        if position.size_base > 0:
            return (position.entry_price * position.size_base - position.margin) / (position.size_base * (Decimal(1) - mmr))
        size = abs(position.size_base)
        return (position.margin + position.entry_price * size) / (size * (Decimal(1) + mmr))

    def apply_bad_debt_waterfall(self, debt: Decimal, backstop_cap: Decimal) -> dict[str, Decimal]:
        debt = max(ZERO, Decimal(debt))
        insurance_used = min(debt, self.insurance)
        self.insurance -= insurance_used
        debt -= insurance_used
        backstop_used = min(debt, Decimal(backstop_cap))
        debt -= backstop_used
        return {"insurance": insurance_used, "backstop": backstop_used, "adl_or_socialized": debt}


def wad(value: Decimal, rounding=ROUND_DOWN) -> int:
    return int((Decimal(value) * Decimal(10**18)).quantize(Decimal(1), rounding=rounding))
