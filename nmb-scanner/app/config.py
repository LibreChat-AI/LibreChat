import logging
import os
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("nmb.config")
_BASE = Path(__file__).resolve().parent.parent


@dataclass
class Settings:
    data_dir: Path
    policy_file: Path
    blocklist_file: Path
    vault_key: str
    service_key: str | None
    spacy_model: str | None

    @classmethod
    def from_env(cls) -> "Settings":
        from cryptography.fernet import Fernet

        key = os.environ.get("NMB_VAULT_KEY")
        if not key:
            key = Fernet.generate_key().decode()
            log.warning(
                "NMB_VAULT_KEY not set: using an EPHEMERAL key. Stored mappings and "
                "review originals will be unreadable after restart. Set it in production."
            )
        return cls(
            data_dir=Path(os.environ.get("NMB_DATA_DIR", _BASE / "data")),
            policy_file=Path(os.environ.get("NMB_POLICY_FILE", _BASE / "config" / "policy.yaml")),
            blocklist_file=Path(os.environ.get("NMB_BLOCKLIST_FILE", _BASE / "config" / "blocklist.yaml")),
            vault_key=key,
            service_key=os.environ.get("NMB_SERVICE_KEY") or None,
            spacy_model=os.environ.get("NMB_SPACY_MODEL") or None,
        )
