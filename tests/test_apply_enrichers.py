import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from apply_enrichers import apply_enrichers_to_json


def test_apply_enrichers_preserves_existing_fields(tmp_path):
    data = {
        "nodes": [
            {
                "id": "10.1.1.1",
                "ip": "10.1.1.1",
                "degree": 2,
                "ports": [80],
                "community": 0,
                "role_guess": "web_server",
                "zone_id": "z1",
                "zone_label": "web-zone",
                "anomaly_level": "Low",
                "is_core_infra": True,
                "domain_source": "core_infra",
            }
        ],
        "links": [],
    }
    src = tmp_path / "input.json"
    dst = tmp_path / "output.json"
    src.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    config = str(Path(__file__).parent.parent / "config" / "enrichers.yaml")
    apply_enrichers_to_json(str(src), str(dst), config_path=config)

    out = json.loads(dst.read_text(encoding="utf-8"))
    node = out["nodes"][0]
    assert node["role_guess"] == "web_server"
    assert node["zone_id"] == "z1"
    assert node["zone_label"] == "web-zone"
    assert node["anomaly_level"] == "Low"
    assert node["is_core_infra"] is True
    assert node["domain_source"] == "core_infra"
    assert node["service_type"] == "Web"
