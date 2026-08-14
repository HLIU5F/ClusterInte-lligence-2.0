import type { RawLog, TopologyData, TopologyNode, TopologyLink } from './types';
import { IsolationForest, extractAnomalyFeatures, getAnomalyLevel } from './isolationForest';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { density, modularity } from 'graphology-metrics/graph';

// Port → role mapping
const PORT_ROLE_MAP: Record<string, string> = {
  '80': 'WebTier', '443': 'WebTier', '8080': 'WebTier', '8443': 'WebTier',
  '3306': 'Database', '5432': 'Database', '27017': 'Database', '6379': 'Cache',
  '11211': 'Cache', '9092': 'MQ', '5672': 'MQ', '61616': 'MQ',
  '9094': 'MQ', '9093': 'MQ', '2181': 'ZooKeeper', '81': 'WebTier',
  '1514': 'Syslog', '1516': 'Syslog', '1517': 'Syslog', '36000': 'Monitor',
  '9100': 'Monitor', '7070': 'Monitor', '9000': 'Monitor',
  '6380': 'Cache', '16380': 'Cache', '53': 'DNS', '22': 'SSH',
};

// IP range → category
function getCategory(ip: string): string {
  const parts = ip.split('.').map(Number);
  if (parts[0] === 10) {
    if (parts[1] >= 10 && parts[1] <= 19) return 'App';
    if (parts[1] >= 20 && parts[1] <= 29) return 'Biz';
  }
  return 'Infra';
}

function getRoleFromPort(port: number): string {
  return PORT_ROLE_MAP[String(port)] || 'Unknown';
}

// Analyze traffic direction for a node
function analyzeDirection(
  nodeIp: string,
  logs: RawLog[]
): 'Client' | 'Server' | 'Target-Receiver' | 'Mixed' {
  let outCount = 0;
  let inCount = 0;

  for (const log of logs) {
    if (log.src === nodeIp) outCount++;
    if (log.dst === nodeIp) inCount++;
  }

  const total = outCount + inCount;
  if (total === 0) return 'Client';

  const outRatio = outCount / total;
  if (outRatio > 0.7) return 'Client';
  if (outRatio < 0.3) return 'Server';
  if (outRatio > 0.5) return 'Target-Receiver';
  return 'Mixed';
}

// Get dominant port for a node
function getDominantPort(nodeIp: string, logs: RawLog[]): number {
  const portCount: Record<number, number> = {};

  for (const log of logs) {
    if (log.src === nodeIp || log.dst === nodeIp) {
      const port = log.dport;
      portCount[port] = (portCount[port] || 0) + 1;
    }
  }

  let maxPort = 0;
  let maxCount = 0;
  for (const [port, count] of Object.entries(portCount)) {
    if (count > maxCount) {
      maxCount = count;
      maxPort = Number(port);
    }
  }

  return maxPort;
}

// Guess role from dominant port
function guessRole(nodeIp: string, logs: RawLog[]): string {
  const port = getDominantPort(nodeIp, logs);
  return getRoleFromPort(port);
}

export function convertRawLogsToTopology(logs: RawLog[]): TopologyData {
  // Step 1: Build node and link maps
  const nodeMap = new Map<string, {
    id: string;
    degree: number;
    inDegree: number;
    outDegree: number;
    bytesSent: number;
    bytesReceived: number;
    ports: Set<number>;
  }>();

  const linkMap = new Map<string, {
    source: string;
    target: string;
    weight: number;
    bytes: number;
  }>();

  for (const log of logs) {
    const src = log.src;
    const dst = log.dst;

    // Update node stats
    if (!nodeMap.has(src)) {
      nodeMap.set(src, { id: src, degree: 0, inDegree: 0, outDegree: 0, bytesSent: 0, bytesReceived: 0, ports: new Set() });
    }
    if (!nodeMap.has(dst)) {
      nodeMap.set(dst, { id: dst, degree: 0, inDegree: 0, outDegree: 0, bytesSent: 0, bytesReceived: 0, ports: new Set() });
    }

    const srcNode = nodeMap.get(src)!;
    const dstNode = nodeMap.get(dst)!;

    srcNode.outDegree++;
    srcNode.degree++;
    dstNode.inDegree++;
    dstNode.degree++;
    srcNode.ports.add(log.dport);
    dstNode.ports.add(log.dport);

    // Update link stats
    const linkKey = `${src}->${dst}`;
    if (!linkMap.has(linkKey)) {
      linkMap.set(linkKey, { source: src, target: dst, weight: 0, bytes: 0 });
    }
    const link = linkMap.get(linkKey)!;
    link.weight++;
    link.bytes += 1024; // estimate
  }

  // Step 3: Build graph and run Louvain community detection
  const graph = new Graph();
  
  // Add nodes
  for (const [nodeId] of nodeMap) {
    graph.addNode(nodeId);
  }
  
  // Add edges with weights
  for (const link of linkMap.values()) {
    graph.addEdgeWithKey(`${link.source}->${link.target}`, link.source, link.target, { weight: link.weight });
  }
  
  // Calculate adaptive resolution based on graph density and size
  const nodeCount = nodeMap.size;
  const edgeCount = linkMap.size;
  const density = (2 * edgeCount) / (nodeCount * (nodeCount - 1));
  
  // Adaptive resolution: higher for sparse graphs to detect finer structure
  // Lower for dense graphs to avoid over-segmentation
  // In Louvain: higher resolution = more communities, lower = fewer communities
  let resolution = 1.0;
  if (density < 0.05) {
    resolution = 1.5; // Very sparse graph: higher resolution
  } else if (density < 0.1) {
    resolution = 1.2;
  } else if (density > 0.3) {
    resolution = 0.8; // Dense graph: lower resolution to avoid over-segmentation
  }
  
  // Run Louvain with adaptive resolution
  const rawCommunities = louvain(graph, { resolution });
  
  // Create a mutable copy and ensure all nodes are in the partition
  const communities: {[node: string]: number} = {};
  const allNodes = graph.nodes() as string[];
  for (const node of allNodes) {
    communities[node] = rawCommunities[node] !== undefined ? rawCommunities[node] : 0;
  }
  
  // Count initial communities
  const initialCommunityCount = new Set(Object.values(communities)).size;
  console.log(`Louvain produced ${initialCommunityCount} communities for ${allNodes.length} nodes`);
  
  // Check if largest community is too dominant (>50% of nodes)
  const initialCommunitySizes = new Map<number, number>();
  for (const commId of Object.values(communities)) {
    initialCommunitySizes.set(commId, (initialCommunitySizes.get(commId) || 0) + 1);
  }
  const largestCommunitySize = Math.max(...Array.from(initialCommunitySizes.values()));
  const isDominant = largestCommunitySize > allNodes.length * 0.5;
  
  // Fallback to rule-based grouping if Louvain produces too few communities or one dominates
  let useRuleBased = false;
  if ((initialCommunityCount <= 2 || isDominant) && allNodes.length > 10) {
    console.warn(`Louvain produced ${initialCommunityCount} communities (largest: ${largestCommunitySize}/${allNodes.length}), falling back to rule-based grouping`);
    useRuleBased = true;
    
    // Use fine-grained profile-based grouping (subnet + port_range + role + direction)
    const profileMap = new Map<string, number>();
    let profileId = 0;
    
    // Get port range for grouping (group ports into ranges)
    const getPortRange = (ports: Set<number>): string => {
      const portArray = Array.from(ports);
      if (portArray.length === 0) return 'none';
      
      // Categorize by port ranges
      const hasWeb = portArray.some(p => [80, 443, 8080, 8443].includes(p));
      const hasDB = portArray.some(p => [3306, 5432, 1521, 1433, 27017].includes(p));
      const hasCache = portArray.some(p => [6379, 11211, 6380].includes(p));
      const hasMQ = portArray.some(p => [9092, 9093, 9094, 2181, 5672].includes(p));
      const hasMonitor = portArray.some(p => [36000, 9100, 7070, 9000, 8086, 9200].includes(p));
      const hasSyslog = portArray.some(p => [514, 1514, 1516, 1517].includes(p));
      const hasInfra = portArray.some(p => [22, 53, 88, 389, 636].includes(p));
      
      const ranges = [];
      if (hasWeb) ranges.push('Web');
      if (hasDB) ranges.push('DB');
      if (hasCache) ranges.push('Cache');
      if (hasMQ) ranges.push('MQ');
      if (hasMonitor) ranges.push('Mon');
      if (hasSyslog) ranges.push('Syslog');
      if (hasInfra) ranges.push('Infra');
      
      return ranges.length > 0 ? ranges.join('+') : 'Other';
    };
    
    for (const node of allNodes) {
      const parts = node.split('.');
      // Use /24 subnet for finer granularity
      const subnet = parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}` : node;
      const nodeData = nodeMap.get(node)!;
      const portRange = getPortRange(nodeData.ports);
      const role = guessRole(node, logs);
      const direction = analyzeDirection(node, logs);
      
      // Combine subnet + port_range + role + direction for fine-grained grouping
      const profile = `${subnet}-${portRange}-${role}-${direction}`;
      
      if (!profileMap.has(profile)) {
        profileMap.set(profile, profileId++);
      }
      communities[node] = profileMap.get(profile)!;
    }
    
    console.log(`Rule-based grouping produced ${profileId} communities`);
  }
  
  // Calculate modularity score (quality metric)
  let modularityScore = 0;
  if (!useRuleBased) {
    try {
      modularityScore = modularity(graph, communities);
    } catch (e) {
      // Modularity calculation failed, use default value
      console.warn('Modularity calculation failed:', e);
    }
  }
  
  // Step 4: Merge small communities below minimum size threshold
  // Skip merging when using rule-based fallback to preserve fine-grained groups
  const MIN_COMMUNITY_SIZE = 2;
  const communitySizes = new Map<number, number>();
  const mergeTarget = new Map<number, number>(); // small -> large
  
  if (!useRuleBased) {
    // Count community sizes
    for (const [nodeId, commId] of Object.entries(communities)) {
      communitySizes.set(commId, (communitySizes.get(commId) || 0) + 1);
    }
    
    console.log('Community sizes before merging:', Array.from(communitySizes.entries()).sort((a, b) => a[0] - b[0]));
    
    // Find communities to merge (too small)
    const smallCommunities = new Set<number>();
    for (const [commId, size] of communitySizes.entries()) {
      if (size < MIN_COMMUNITY_SIZE) {
        smallCommunities.add(commId);
      }
    }
    
    console.log('Small communities to merge:', Array.from(smallCommunities));
    
    // Merge small communities into the most connected larger community
    for (const smallComm of smallCommunities) {
      // Find the most connected larger community
      const smallNodes = Object.entries(communities)
        .filter(([_, commId]) => commId === smallComm)
        .map(([nodeId]) => nodeId as string);
      
      let bestTarget = -1;
      let maxConnections = 0;
      
      for (const node of smallNodes) {
        const neighbors = (graph as any).neighbors(node) as string[];
        for (const neighbor of neighbors) {
          const neighborComm = communities[neighbor];
          if (neighborComm !== undefined && !smallCommunities.has(neighborComm)) {
            const connections = smallNodes.filter(n => (graph as any).hasEdge(n, neighbor)).length;
            if (connections > maxConnections) {
              maxConnections = connections;
              bestTarget = neighborComm;
            }
          }
        }
      }
      
      if (bestTarget >= 0) {
        mergeTarget.set(smallComm, bestTarget);
      }
    }
  }
  
  // Assign final community IDs with merging
  const domainNames = new Map<number, string>();
  const nodeCommunityMap = new Map<string, number>();
  let communityId = 0;
  const commIdMapping = new Map<number, number>(); // old -> new
  
  for (const [nodeId, oldCommId] of Object.entries(communities)) {
    let finalCommId = oldCommId;
    
    // If this is a small community, merge it
    if (mergeTarget.has(oldCommId)) {
      finalCommId = mergeTarget.get(oldCommId)!;
    }
    
    // Map to new sequential ID
    if (!commIdMapping.has(finalCommId)) {
      commIdMapping.set(finalCommId, communityId);
      
      // Generate domain name based on majority profile in this community
      const communityNodes = Object.entries(communities)
        .filter(([_, commId]) => {
          let resolved = commId;
          if (mergeTarget.has(commId)) resolved = mergeTarget.get(commId)!;
          return resolved === finalCommId;
        })
        .map(([nodeId, _]) => nodeId as string);
      
      // Find majority category, role, direction, and subnet
      const categoryCount = new Map<string, number>();
      const roleCount = new Map<string, number>();
      const directionCount = new Map<string, number>();
      const subnetCount = new Map<string, number>();
      
      for (const nId of communityNodes) {
        const nodeId = nId as string;
        const cat = getCategory(nodeId);
        const role = guessRole(nodeId, logs);
        const dir = analyzeDirection(nodeId, logs);
        const parts = nodeId.split('.');
        const subnet = parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}` : 'unknown';
        
        categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);
        roleCount.set(role, (roleCount.get(role) || 0) + 1);
        directionCount.set(dir, (directionCount.get(dir) || 0) + 1);
        subnetCount.set(subnet, (subnetCount.get(subnet) || 0) + 1);
      }
      
      const majorityCategory = Array.from(categoryCount.entries()).sort((a, b) => b[1] - a[1])[0][0];
      const majorityRole = Array.from(roleCount.entries()).sort((a, b) => b[1] - a[1])[0][0];
      const majorityDirection = Array.from(directionCount.entries()).sort((a, b) => b[1] - a[1])[0][0];
      const majoritySubnet = Array.from(subnetCount.entries()).sort((a, b) => b[1] - a[1])[0][0];
      
      // Include subnet for better differentiation
      const domainName = `${majorityCategory}-${majorityRole}-${majorityDirection}-${majoritySubnet}`;
      domainNames.set(communityId, domainName);
      communityId++;
    }
    
    nodeCommunityMap.set(nodeId, commIdMapping.get(finalCommId)!);
  }

  // Recalculate modularity after merging
  const finalPartition: Record<string, number> = {};
  for (const [nodeId, commId] of nodeCommunityMap.entries()) {
    finalPartition[nodeId] = commId;
  }
  let finalModularity = 0;
  try {
    finalModularity = modularity(graph as any, finalPartition);
  } catch (e) {
    console.warn('Final modularity calculation failed:', e);
  }

  // Step 5: Calculate anomaly scores using Isolation Forest
  const nodesList = Array.from(nodeMap.values());
  
  // Calculate community sizes for feature extraction
  const finalCommunitySizes = new Map<number, number>();
  for (const nodeId of nodesList.map(n => n.id)) {
    const cid = nodeCommunityMap.get(nodeId) ?? 0;
    finalCommunitySizes.set(cid, (finalCommunitySizes.get(cid) ?? 0) + 1);
  }
  
  // Extract features for Isolation Forest
  const features = extractAnomalyFeatures(nodesList.map(node => ({
    degree: node.degree,
    in_degree: node.inDegree,
    out_degree: node.outDegree,
    port_count: node.ports.size,
    community_size: finalCommunitySizes.get(nodeCommunityMap.get(node.id) ?? 0) ?? 1,
  })));
  
  // Train and predict with Isolation Forest
  const iforest = new IsolationForest({
    nTrees: 100,
    sampleSize: Math.min(256, nodesList.length),
    threshold: 0.6,
  });
  iforest.fit(features);
  const predictions = iforest.predictWithLabels(features);

  // Step 6: Build final topology data
  const nodes: TopologyNode[] = nodesList.map((node, index) => {
    const communityId = nodeCommunityMap.get(node.id) ?? 0;
    const prediction = predictions[index];
    const role = guessRole(node.id, logs);

    return {
      id: node.id,
      community: communityId,
      degree: node.degree,
      in_degree: node.inDegree,
      out_degree: node.outDegree,
      bytes_sent: node.bytesSent,
      bytes_received: node.bytesReceived,
      is_anomaly: prediction.isAnomaly,
      anomaly_score: Math.round(prediction.score * 1000) / 1000,
      anomaly_level: getAnomalyLevel(prediction.score),
      role_guess: role,
    };
  });

  const links: TopologyLink[] = Array.from(linkMap.values()).map(link => ({
    source: link.source,
    target: link.target,
    weight: link.weight,
    bytes: link.bytes,
  }));

  // Get unique community count
  const uniqueCommunities = new Set(nodeCommunityMap.values()).size;

  return {
    metadata: {
      generated_at: new Date().toISOString(),
      source: 'excel_import',
      total_nodes: nodes.length,
      total_links: links.length,
      communities: uniqueCommunities,
      modularity: Math.round(finalModularity * 1000) / 1000,
      resolution_used: resolution,
      min_community_size: MIN_COMMUNITY_SIZE,
    },
    nodes,
    links,
    domainNames: Object.fromEntries(domainNames),
  };
}

/**
 * 应用白名单规则：将白名单中的节点标记为非异常
 */
export function applyWhitelist(
  data: TopologyData,
  whitelist: Array<{ nodeId: string }>
): TopologyData {
  if (!whitelist || whitelist.length === 0) return data;

  const whitelistSet = new Set(whitelist.map(w => w.nodeId));

  const nodes = data.nodes.map(node => {
    if (whitelistSet.has(node.id)) {
      return {
        ...node,
        is_anomaly: false,
        anomaly_score: 0,
        anomaly_level: 'Low' as const,
      };
    }
    return node;
  });

  // 重新计算异常统计
  const anomalyCount = nodes.filter(n => n.is_anomaly).length;
  const criticalCount = nodes.filter(n => n.anomaly_level === 'Critical').length;
  const highCount = nodes.filter(n => n.anomaly_level === 'High').length;
  const mediumCount = nodes.filter(n => n.anomaly_level === 'Medium').length;

  return {
    ...data,
    nodes,
  };
}
