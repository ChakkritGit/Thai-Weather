"""Forecast verification against station observations.

Kept outside ``app`` on purpose: it is an offline tool (archive forecasts, fetch
observations, score) that talks to the running API over HTTP and never touches
the serving code path.
"""
