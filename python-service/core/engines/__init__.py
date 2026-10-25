"""Common Trading Core — broker-agnostic engines.

Every engine here is terminal-agnostic: it speaks only the BrokerAdapter
contract and the canonical domain shapes from ``brokers.models``. Order
placement ALWAYS passes through Risk → Audit → Adapter, for every terminal
including Dummy and any future AI executor.
"""