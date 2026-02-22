import copy
import json
import sys
import textwrap

from constrainthg import Hypergraph


def get_inputs(json_data: dict, frame_key: str) -> dict:
    """Returns a dictionary of inputs for a simulation."""
    try:
        raw_inputs = dict(json_data['frames'][frame_key])
        # Frame values are stored as lists; unwrap single-element lists.
        inputs = {}
        for k, v in raw_inputs.items():
            inputs[k] = v[0] if isinstance(v, list) and len(v) == 1 else v
        return inputs
    except Exception:
        return {}


def preprocess_json(json_data: dict) -> dict:
    """Prepares JSON data for from_json compatibility.

    Two issues exist in constrainthg.Hypergraph.from_json:
    1. process_method uses exec(), but rel strings in .chg files are stored
       with leading indentation (from inspect.getsource). textwrap.dedent fixes this.
    2. process_json_edge calls source_nodes.items(), but to_dict() serialises
       source_nodes as a list. Convert lists to keyed dicts so .items() works.
    """
    data = copy.deepcopy(json_data)
    hg = data.get('hypergraph', data)
    for edge in hg.get('edges', []):
        for field in ['rel', 'via', 'index_via']:
            if field in edge and isinstance(edge[field], str):
                edge[field] = textwrap.dedent(edge[field])
        sn = edge.get('source_nodes')
        if isinstance(sn, list):
            edge['source_nodes'] = {f's{i + 1}': v for i, v in enumerate(sn)}
    return data


def make_hypergraph(json_data: dict) -> Hypergraph:
    """Creates the hypergraph from a parsed JSON dict."""
    hg = Hypergraph()
    hg.from_json(blob=json.dumps(preprocess_json(json_data)))
    return hg


def get_path_info(t) -> dict:
    """Extracts path nodes and edges from a TNode simulation result."""
    descendants = t.get_descendents()
    path_nodes = set()
    path_edges = set()
    for tn in descendants:
        path_nodes.add(tn.node_label)
        if tn.gen_edge_label:
            # gen_edge_label is 'edge_label#search_counter'; strip the counter suffix.
            path_edges.add(tn.gen_edge_label.rsplit('#', 1)[0])
    return {
        'path_nodes': list(path_nodes),
        'path_edges': list(path_edges),
        'num_nodes': len(path_nodes),
        'num_edges': len(path_edges),
    }


def simulate(file_path: str, output_node: str, frame_key: str, **kwargs):
    """Simulates a hypergraph for the specified output_node."""
    with open(file_path, 'r') as f:
        json_data = json.load(f)
    hg = make_hypergraph(json_data)
    inputs = get_inputs(json_data, frame_key)

    t = hg.solve(output_node, inputs=inputs, **kwargs)
    return t


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'Usage: simulate_chg.py <file_path> <output_node> [frame_key]'}))
        sys.exit(1)

    file_path = sys.argv[1]
    output_node = sys.argv[2]
    frame_key = sys.argv[3] if len(sys.argv) > 3 else ''
    to_print = sys.argv[4].lower() != 'false' if len(sys.argv) > 4 else True
    min_index = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    logging_level = int(sys.argv[6]) if len(sys.argv) > 6 else 0
    debug_nodes = [n for n in sys.argv[7].split(',') if n] if len(sys.argv) > 7 else []
    debug_edges = [e for e in sys.argv[8].split(',') if e] if len(sys.argv) > 8 else []

    solve_kwargs: dict = dict(to_print=to_print, min_index=min_index,
                              debug_nodes=debug_nodes, debug_edges=debug_edges)
    if logging_level > 0:
        solve_kwargs['logging_level'] = logging_level

    try:
        t = simulate(file_path, output_node, frame_key, **solve_kwargs)
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)

    if t is not None:
        path_info = get_path_info(t)
        print(json.dumps({
            'msg': str(t),
            'value': t.value,
            'cost': t.cost,
            'tree': t.get_tree(),
            'target_node': output_node,
            **path_info,
        }))
    else:
        print(json.dumps({'error': 'No solution found'}))
        sys.exit(1)
