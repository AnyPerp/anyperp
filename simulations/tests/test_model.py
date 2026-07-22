from decimal import Decimal

from simulations.anyperp.model import MarketModel, Position, RiskTier


def test_profitable_long_and_lp_inverse():
    market = MarketModel(RiskTier.ESTABLISHED, Decimal("1000000"), Decimal("50000"))
    position = Position(margin=Decimal("20000"))
    market.trade(position, Decimal("100"), Decimal("100"), Decimal("10"))
    lp_before = market.liquidity
    result = market.trade(position, Decimal("-100"), Decimal("110"), Decimal("10"))
    assert result.realized_pnl > 0
    assert market.liquidity < lp_before + result.fee
    assert position.size_base == 0


def test_profitable_short():
    market = MarketModel(RiskTier.EMERGING, Decimal("500000"), Decimal("30000"))
    position = Position(margin=Decimal("30000"))
    market.trade(position, Decimal("-200"), Decimal("50"), Decimal("15"))
    result = market.trade(position, Decimal("200"), Decimal("40"), Decimal("15"))
    assert result.realized_pnl > 0


def test_weighted_average_entry():
    market = MarketModel(RiskTier.BLUE_CHIP, Decimal("1000000"), Decimal("50000"))
    position = Position(margin=Decimal("50000"))
    first = market.trade(position, Decimal("10"), Decimal("100"), Decimal(0))
    second = market.trade(position, Decimal("10"), Decimal("120"), Decimal(0))
    assert first.new_entry_price > Decimal("100")
    assert second.new_entry_price > first.new_entry_price
    assert second.new_entry_price < second.execution_price


def test_liquidation_prices_are_directional():
    market = MarketModel(RiskTier.ESTABLISHED, Decimal("1000000"), Decimal("50000"))
    long = Position(Decimal("10"), Decimal("100"), Decimal("300"))
    short = Position(Decimal("-10"), Decimal("100"), Decimal("300"))
    assert market.liquidation_price_approx(long) < Decimal("100")
    assert market.liquidation_price_approx(short) > Decimal("100")


def test_bad_debt_is_isolated_and_capped():
    market = MarketModel(RiskTier.EXPERIMENTAL, Decimal("100000"), Decimal("1000"))
    waterfall = market.apply_bad_debt_waterfall(Decimal("5000"), Decimal("2000"))
    assert waterfall == {
        "insurance": Decimal("1000"),
        "backstop": Decimal("2000"),
        "adl_or_socialized": Decimal("2000"),
    }
    assert market.insurance == 0


def test_marked_lp_nav_recognizes_profitable_trader_liability():
    market = MarketModel(RiskTier.EXPERIMENTAL, Decimal("100000"), Decimal("10000"), Decimal("0.1"))
    position = Position(size_base=Decimal("100000"), entry_price=Decimal("0.1"), margin=Decimal("7000"))
    nav = market.marked_lp_nav([position], Decimal("10"))
    assert nav < 0


def test_stressed_reserve_increases_with_long_open_interest():
    market = MarketModel(RiskTier.EXPERIMENTAL, Decimal("1000000"), Decimal("50000"), Decimal("100"))
    position = Position(margin=Decimal("100000"))
    market.trade(position, Decimal("100"), Decimal("100"), Decimal("10"))
    assert market.required_reserve(Decimal("100")) > 0
    assert market.required_reserve(Decimal("100")) <= market.utilization_limit()


def test_funding_uses_fixed_base_skew_scale_like_contract():
    market = MarketModel(RiskTier.ESTABLISHED, Decimal("1000000"), Decimal("50000"), Decimal("100"))
    market.long_oi_base = market.max_skew_base
    rate = market.accrue_funding(Decimal("100"), 1, Decimal("0.000001"), Decimal("1"))
    assert rate == Decimal("0.0001")
