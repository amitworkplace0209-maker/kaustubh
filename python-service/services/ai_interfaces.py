"""Phase 4 AI Extension Interfaces.

Pre-baked interfaces for future AI integration. These are stable contracts
that the AI layer can plug into without rewriting the trading core.

Phase 4 AI is NOT required for the basic trading terminal to work.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, Optional

logger = logging.getLogger("app.ai_interfaces")


class AIModelProvider(ABC):
    """Interface for AI model providers."""

    @abstractmethod
    async def predict(self, features: dict[str, Any]) -> dict[str, Any]:
        """Run prediction on feature data. Returns model output."""

    @abstractmethod
    def model_info(self) -> dict:
        """Return model metadata (name, version, type)."""


class AIFeatureProvider(ABC):
    """Interface for AI feature stores."""

    @abstractmethod
    async def get_features(self, symbol: str, feature_set: str = "default") -> dict[str, Any]:
        """Retrieve computed features for a symbol."""

    @abstractmethod
    async def store_features(self, symbol: str, features: dict[str, Any]) -> bool:
        """Store computed features."""


class AISuggestionProvider(ABC):
    """Interface for AI suggestion generation."""

    @abstractmethod
    async def generate_suggestion(self, context: dict[str, Any]) -> Optional[dict]:
        """Generate a trading suggestion from market context."""


class AIRiskProvider(ABC):
    """Interface for AI risk analysis."""

    @abstractmethod
    async def assess_risk(self, order: dict, positions: list[dict], margin: dict) -> dict:
        """Assess risk for a proposed order given current portfolio."""


class AIExplanationProvider(ABC):
    """Interface for AI explanation generation."""

    @abstractmethod
    async def explain(self, suggestion: dict, context: dict[str, Any]) -> str:
        """Generate human-readable explanation for a suggestion."""


class AIModelRegistry:
    """Registry for AI model providers."""

    def __init__(self) -> None:
        self._providers: dict[str, AIModelProvider] = {}
        self._feature_stores: dict[str, AIFeatureProvider] = {}
        self._suggestion_providers: dict[str, AISuggestionProvider] = {}
        self._risk_providers: dict[str, AIRiskProvider] = {}
        self._explanation_providers: dict[str, AIExplanationProvider] = {}

    def register_model(self, name: str, provider: AIModelProvider) -> None:
        self._providers[name] = provider
        logger.info("[AI] registered model provider: %s", name)

    def register_feature_store(self, name: str, provider: AIFeatureProvider) -> None:
        self._feature_stores[name] = provider
        logger.info("[AI] registered feature store: %s", name)

    def register_suggestion_provider(self, name: str, provider: AISuggestionProvider) -> None:
        self._suggestion_providers[name] = provider
        logger.info("[AI] registered suggestion provider: %s", name)

    def register_risk_provider(self, name: str, provider: AIRiskProvider) -> None:
        self._risk_providers[name] = provider
        logger.info("[AI] registered risk provider: %s", name)

    def register_explanation_provider(self, name: str, provider: AIExplanationProvider) -> None:
        self._explanation_providers[name] = provider
        logger.info("[AI] registered explanation provider: %s", name)

    def get_model(self, name: str) -> Optional[AIModelProvider]:
        return self._providers.get(name)

    def list_models(self) -> list[str]:
        return list(self._providers.keys())

    def summary(self) -> dict:
        return {
            "models": list(self._providers.keys()),
            "featureStores": list(self._feature_stores.keys()),
            "suggestionProviders": list(self._suggestion_providers.keys()),
            "riskProviders": list(self._risk_providers.keys()),
            "explanationProviders": list(self._explanation_providers.keys()),
        }


# Module singleton
ai_registry = AIModelRegistry()
