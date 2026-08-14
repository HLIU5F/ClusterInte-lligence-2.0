import type { TopologyData } from './types';
import { getAnomalyLevel } from './types';

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

export function generateMockData(nodeCount: number = 100): TopologyData {
  const rand = seededRandom(42);

  const roles = ['web_server', 'database', 'cache', 'message_queue', 'monitoring'];
  const communityCount = Math.max(3, Math.floor(nodeCount / 12));

  // Generate nodes
  const nodes = Array.from({ length: nodeCount }, (_, i) => {
    const community = Math.floor(rand() * communityCount);
    const role = roles[community % roles.length];
    const isAnomaly = rand() < 0.05;
    const anomalyScore = isAnomaly ? 0.6 + rand() * 0.35 : rand() * 0.4;
    const degree = Math.floor(5 + rand() * 40);
    const bytesSent = Math.floor(100000 + rand() * 50000000);
    const bytesReceived = Math.floor(100000 + rand() * 80000000);

    const subnet = Math.floor(community / 4);
    const host = (i % 254) + 1;
    const id = `10.${subnet + 1}.${Math.floor(i / 254) + 1}.${host}`;

    return {
      id,
      community,
      degree,
      in_degree: Math.floor(degree * (0.3 + rand() * 0.4)),
      out_degree: degree - Math.floor(degree * (0.3 + rand() * 0.4)),
      bytes_sent: bytesSent,
      bytes_received: bytesReceived,
      is_anomaly: isAnomaly,
      anomaly_score: parseFloat(anomalyScore.toFixed(3)),
      anomaly_level: getAnomalyLevel(anomalyScore),
      role_guess: role,
    };
  });

  // Generate links - nodes in same community are more likely to connect
  const links: TopologyData['links'] = [];
  const linkSet = new Set<string>();

  for (let i = 0; i < nodes.length; i++) {
    const connectionCount = Math.floor(2 + rand() * 6);
    for (let c = 0; c < connectionCount; c++) {
      let targetIdx: number;
      if (rand() < 0.7) {
        // Same community connection
        const sameCommunity = nodes
          .map((n, idx) => ({ n, idx }))
          .filter(({ n, idx }) => n.community === nodes[i].community && idx !== i);
        if (sameCommunity.length === 0) continue;
        targetIdx = sameCommunity[Math.floor(rand() * sameCommunity.length)].idx;
      } else {
        // Cross community connection
        targetIdx = Math.floor(rand() * nodes.length);
        if (targetIdx === i) continue;
      }

      const key = [Math.min(i, targetIdx), Math.max(i, targetIdx)].join('-');
      if (linkSet.has(key)) continue;
      linkSet.add(key);

      links.push({
        source: nodes[i].id,
        target: nodes[targetIdx].id,
        weight: Math.floor(10 + rand() * 500),
        bytes: Math.floor(10000 + rand() * 10000000),
      });
    }
  }

  // Ensure connectivity - connect isolated nodes
  const connected = new Set<string>();
  links.forEach(l => {
    connected.add(typeof l.source === 'string' ? l.source : l.source.id);
    connected.add(typeof l.target === 'string' ? l.target : l.target.id);
  });
  nodes.forEach(node => {
    if (!connected.has(node.id)) {
      const targetIdx = Math.floor(rand() * nodes.length);
      if (targetIdx !== nodes.indexOf(node)) {
        links.push({
          source: node.id,
          target: nodes[targetIdx].id,
          weight: Math.floor(10 + rand() * 100),
          bytes: Math.floor(10000 + rand() * 1000000),
        });
      }
    }
  });

  return {
    metadata: {
      generated_at: new Date().toISOString().split('T')[0],
      source: 'mock_data',
      total_nodes: nodes.length,
      total_links: links.length,
      communities: communityCount,
    },
    nodes,
    links,
  };
}
